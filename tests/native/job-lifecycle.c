/*
 * 真实Windows作业专项夹具，不包含生产令牌或调度器接口。
 * Controller只持外层清理guard；被测内层job只有合成Parent持有。
 * 所有身份、硬停止和退出断言均在guard未关闭时完成，不能把guard兜底冒称内层job验收。
 */
#define WIN32_LEAN_AND_MEAN
#include <windows.h>
#include <stdio.h>
#include <stdlib.h>
#include <stdint.h>
#include <string.h>
#include <wchar.h>
#include "background-binding.h"

#ifndef EXTENDED_STARTUPINFO_PRESENT
#define EXTENDED_STARTUPINFO_PRESENT 0x00080000
#endif
#define TEST_ATTRIBUTE_JOB_LIST ((DWORD_PTR)0x0002000d)
#define TEST_ATTRIBUTE_HANDLE_LIST ((DWORD_PTR)0x00020002)
#define TEST_COMPLETION_KEY ((ULONG_PTR)0x415752)
#define TEST_EXIT_CODE ((DWORD)0xf1234567)

typedef BOOL (WINAPI *TestInitializeAttributes)(void *, DWORD, DWORD, SIZE_T *);
typedef BOOL (WINAPI *TestUpdateAttribute)(void *, DWORD, DWORD_PTR, void *, SIZE_T, void *, SIZE_T *);
typedef void (WINAPI *TestDeleteAttributes)(void *);
typedef BOOL (WINAPI *TestQueryImage)(HANDLE, DWORD, WCHAR *, DWORD *);
typedef BOOL (WINAPI *TestProcessInJob)(HANDLE, HANDLE, PBOOL);
typedef struct { STARTUPINFOW startup; void *attributes; } TestStartupInfoEx;
typedef struct {
    volatile LONG phase;
    volatile LONG error;
    volatile LONG creation_returned;
    volatile LONG metadata_published;
    volatile LONG inner_job_inherited;
    volatile LONG root_acquired;
    volatile LONG root_exited;
    volatile LONG exit_acknowledged;
    DWORD root_id;
    FILETIME root_creation;
} TestSharedState;
typedef struct {
    TestInitializeAttributes initialize;
    TestUpdateAttribute update;
    TestDeleteAttributes destroy;
    TestQueryImage image;
    TestProcessInJob process_in_job;
} TestApis;

/** 只从已加载系统kernel32取得旧编译头缺失的固定导出，不搜索或载入任何工作区动态库。 */
static BOOL load_apis(TestApis *apis) {
    HMODULE module = GetModuleHandleW(L"kernel32.dll");
    if (module == NULL) return FALSE;
    apis->initialize = (TestInitializeAttributes)(void *)GetProcAddress(module, "InitializeProcThreadAttributeList");
    apis->update = (TestUpdateAttribute)(void *)GetProcAddress(module, "UpdateProcThreadAttribute");
    apis->destroy = (TestDeleteAttributes)(void *)GetProcAddress(module, "DeleteProcThreadAttributeList");
    apis->image = (TestQueryImage)(void *)GetProcAddress(module, "QueryFullProcessImageNameW");
    apis->process_in_job = (TestProcessInJob)(void *)GetProcAddress(module, "IsProcessInJob");
    return apis->initialize != NULL && apis->update != NULL && apis->destroy != NULL && apis->image != NULL && apis->process_in_job != NULL;
}

/** 建立夹具扩展属性存储；每项调用都检查结果，Windows不支持时失败，不使用创建后关联回退。 */
static void *attributes_create(const TestApis *apis, DWORD count) {
    SIZE_T size = 0;
    void *storage;
    SetLastError(ERROR_SUCCESS);
    if (apis->initialize(NULL, count, 0, &size) || GetLastError() != ERROR_INSUFFICIENT_BUFFER || size == 0) return NULL;
    storage = calloc(1, size);
    if (storage == NULL) return NULL;
    if (!apis->initialize(storage, count, 0, &size)) { free(storage); return NULL; }
    return storage;
}

/** 校验本夹具真正普通权限：主令牌中等完整性且有效管理员角色为假；不等同生产过滤后S4U契约。 */
static BOOL is_limited_parent(void) {
    HANDLE token = NULL;
    HANDLE query_token = NULL;
    PSID administrators = NULL;
    SID_IDENTIFIER_AUTHORITY authority = {{0, 0, 0, 0, 0, 5}};
    BOOL member = TRUE, valid = FALSE;
    DWORD size = 0;
    TOKEN_MANDATORY_LABEL *label = NULL;
    if (!OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY | TOKEN_DUPLICATE, &token)) goto cleanup;
    if (!AllocateAndInitializeSid(&authority, 2, SECURITY_BUILTIN_DOMAIN_RID, DOMAIN_ALIAS_RID_ADMINS,
        0, 0, 0, 0, 0, 0, &administrators)) goto cleanup;
    /* 管理员角色与完整性必须来自同一真实主令牌；不把已有线程模拟方与主令牌数据混用。 */
    if (!DuplicateTokenEx(token, TOKEN_QUERY | TOKEN_IMPERSONATE, NULL, SecurityImpersonation,
        TokenImpersonation, &query_token) || !CheckTokenMembership(query_token, administrators, &member) || member) goto cleanup;
    GetTokenInformation(token, TokenIntegrityLevel, NULL, 0, &size);
    if (GetLastError() != ERROR_INSUFFICIENT_BUFFER || size == 0) goto cleanup;
    label = malloc(size);
    if (label == NULL || !GetTokenInformation(token, TokenIntegrityLevel, label, size, &size)) goto cleanup;
    if (*GetSidSubAuthority(label->Label.Sid, *GetSidSubAuthorityCount(label->Label.Sid) - 1) != SECURITY_MANDATORY_MEDIUM_RID) goto cleanup;
    valid = TRUE;
cleanup:
    if (token != NULL) CloseHandle(token);
    if (query_token != NULL) CloseHandle(query_token);
    if (administrators != NULL) FreeSid(administrators);
    free(label);
    return valid;
}

/** 比较真实进程创建时刻，不以编号存在或自报内容作为稳定身份；输入均为本次已持句柄。 */
static BOOL creation_identity(HANDLE process, FILETIME *created) {
    FILETIME exited, kernel, user;
    return GetProcessTimes(process, created, &exited, &kernel, &user);
}

/** 区分真实等待超时与Windows接口失败；调用方须在等待后立即读取，避免覆盖原始系统错误。 */
static DWORD wait_error(DWORD result) {
    if (result == WAIT_TIMEOUT) return ERROR_TIMEOUT;
    if (result == WAIT_FAILED) {
        DWORD error = GetLastError();
        return error != ERROR_SUCCESS ? error : ERROR_INVALID_DATA;
    }
    return ERROR_INVALID_DATA;
}

/** 核验本次已持句柄的固定Node或系统控制台辅助映像；前后核对父仍存活，不凭名称或全机扫描归属。 */
static BOOL verify_child(const TestApis *apis, HANDLE child, HANDLE parent, HANDLE guard, const FILETIME *parent_created, BOOL *node) {
    WCHAR image[32768];
    WCHAR system_image[32768];
    DWORD length = (DWORD)(sizeof(image) / sizeof(image[0]));
    FILETIME created, second;
    UINT system_length;
    BOOL in_job = FALSE;
    *node = FALSE;
    if (WaitForSingleObject(parent, 0) != WAIT_TIMEOUT) return FALSE;
    /* 非root后代/辅助进程可能先退出：同一已持句柄必须仍属于本次guard，拒绝同映像PID复用。 */
    if (!apis->process_in_job(child, guard, &in_job) || !in_job) return FALSE;
    if (!creation_identity(child, &created) || CompareFileTime(&created, parent_created) < 0) return FALSE;
    if (!apis->image(child, 0, image, &length)) return FALSE;
    if (lstrcmpiW(image, AWR_NODE_PATH) == 0) *node = TRUE;
    else {
        /* 32位控制器不能用重定向后的SystemDirectory冒充64位系统路径；允许项只来自固定Windows根。 */
        system_length = GetSystemWindowsDirectoryW(system_image, sizeof(system_image) / sizeof(system_image[0]));
        if (system_length == 0 || system_length + wcslen(L"\\System32\\conhost.exe") >= sizeof(system_image) / sizeof(system_image[0])) return FALSE;
        wcscat(system_image, L"\\System32\\conhost.exe");
        if (lstrcmpiW(image, system_image) != 0) {
            system_length = GetSystemWow64DirectoryW(system_image, sizeof(system_image) / sizeof(system_image[0]));
            if (system_length == 0 || system_length + wcslen(L"\\conhost.exe") >= sizeof(system_image) / sizeof(system_image[0])) return FALSE;
            wcscat(system_image, L"\\conhost.exe");
            if (lstrcmpiW(image, system_image) == 0) goto known_image;
        const WCHAR *basename = wcsrchr(image, L'\\');
        fwprintf(stderr, L"fixture-unexpected-image=%ls\n", basename != NULL ? basename + 1 : image);
        return FALSE;
        }
    }
known_image:
    if (!creation_identity(child, &second) || CompareFileTime(&created, &second) != 0) return FALSE;
    in_job = FALSE;
    return apis->process_in_job(child, guard, &in_job) && in_job && WaitForSingleObject(parent, 0) == WAIT_TIMEOUT;
}

/** 合成父持有唯一内层job，在创建阶段关联唯一挂起Node；只继承独立夹具IPC，不继承任何job句柄。 */
static DWORD parent_run(HANDLE port, HANDLE mapping, int mode) {
    TestApis apis;
    TestSharedState *shared = NULL;
    HANDLE job = NULL;
    JOBOBJECT_EXTENDED_LIMIT_INFORMATION limits;
    JOBOBJECT_ASSOCIATE_COMPLETION_PORT association;
    TestStartupInfoEx startup;
    PROCESS_INFORMATION process;
    WCHAR command[32768];
    DWORD result = 11, flags = 0;
    void *attributes = NULL;
    BOOL created = FALSE;
    memset(&apis, 0, sizeof(apis));
    memset(&process, 0, sizeof(process));
    shared = MapViewOfFile(mapping, FILE_MAP_ALL_ACCESS, 0, 0, sizeof(*shared));
    if (shared == NULL || !load_apis(&apis) || !is_limited_parent()) goto cleanup;
    job = CreateJobObjectW(NULL, NULL);
    if (job == NULL || !GetHandleInformation(job, &flags)) goto cleanup;
    shared->inner_job_inherited = (flags & HANDLE_FLAG_INHERIT) != 0;
    if (shared->inner_job_inherited) goto cleanup;
    memset(&limits, 0, sizeof(limits));
    limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
    if (!SetInformationJobObject(job, JobObjectExtendedLimitInformation, &limits, sizeof(limits))) goto cleanup;
    association.CompletionKey = (void *)TEST_COMPLETION_KEY;
    association.CompletionPort = port;
    if (!SetInformationJobObject(job, JobObjectAssociateCompletionPortInformation, &association, sizeof(association))) goto cleanup;
    attributes = attributes_create(&apis, 1);
    if (attributes == NULL || !apis.update(attributes, 0, TEST_ATTRIBUTE_JOB_LIST, &job, sizeof(job), NULL, NULL)) goto cleanup;
    memset(&startup, 0, sizeof(startup));
    startup.startup.cb = sizeof(startup);
    startup.attributes = attributes;
    if (_snwprintf(command, sizeof(command) / sizeof(command[0]), L"\"%ls\" \"%ls\" %ls", AWR_NODE_PATH,
        AWR_RUNNER_PATH, mode == 4 ? L"exit-code" : mode == 3 ? L"tree" : L"leaf") < 0) goto cleanup;
    /* phase=1只说明调用方尚未发布创建结果；不把该观测声称为确定停在内核某条指令。 */
    InterlockedExchange(&shared->phase, 1);
    created = CreateProcessW(AWR_NODE_PATH, command, NULL, NULL, FALSE,
        CREATE_SUSPENDED | CREATE_NO_WINDOW | EXTENDED_STARTUPINFO_PRESENT, NULL, AWR_PROJECT_ROOT,
        &startup.startup, &process);
    if (!created) goto cleanup;
    InterlockedExchange(&shared->creation_returned, 1);
    if (mode == 1) {
        /* 创建已成功返回，但root元数据与phase=2尚未发布。用本夹具明确的阻塞点验证
         * 这个既有观测边界，避免降低父线程优先级争抢一个偶然调度窗口。
         * 控制器仍须取得并核验真实子句柄后硬停止父；不声称捕获了内核创建调用中点。 */
        Sleep(INFINITE);
        goto cleanup;
    }
    shared->root_id = process.dwProcessId;
    if (!creation_identity(process.hProcess, &shared->root_creation)) goto cleanup;
    InterlockedExchange(&shared->metadata_published, 1);
    InterlockedExchange(&shared->phase, 2);
    if (mode == 2) {
        /* 控制器只使用已持父句柄硬停止；父不主动关闭内层job以免把正常清理混入硬停止结果。 */
        Sleep(INFINITE);
        goto cleanup;
    }
    /* 父保留真实root句柄并保持挂起，直到控制器稳定持有及核验该对象；退出码模式不能先关闭句柄。 */
    for (DWORD waited = 0; InterlockedCompareExchange(&shared->root_acquired, 0, 0) == 0; ++waited) {
        if (waited >= 10000) { SetLastError(ERROR_TIMEOUT); goto cleanup; }
        Sleep(1);
    }
    if (ResumeThread(process.hThread) == (DWORD)-1) goto cleanup;
    InterlockedExchange(&shared->phase, 3);
    if (WaitForSingleObject(process.hProcess, INFINITE) != WAIT_OBJECT_0 || !GetExitCodeProcess(process.hProcess, &result)) goto cleanup;
    InterlockedExchange(&shared->root_exited, 1);
    if (mode == 4) {
        /* 子已退出仍保留原始句柄，确保通知中的PID不可能因父提前退出/关闭而复用。 */
        for (DWORD waited = 0; InterlockedCompareExchange(&shared->exit_acknowledged, 0, 0) == 0; ++waited) {
            if (waited >= 10000) { SetLastError(ERROR_TIMEOUT); goto cleanup; }
            Sleep(1);
        }
    }
cleanup:
    if (shared != NULL && result == 11) { shared->error = GetLastError() != 0 ? (LONG)GetLastError() : 11; }
    if (job != NULL) CloseHandle(job);
    if (process.hThread != NULL) CloseHandle(process.hThread);
    if (process.hProcess != NULL) CloseHandle(process.hProcess);
    if (attributes != NULL) { apis.destroy(attributes); free(attributes); }
    if (shared != NULL) UnmapViewOfFile(shared);
    CloseHandle(mapping);
    CloseHandle(port);
    return result;
}

/** 单次真实观测：控制器不持内层job，阶段或身份异常直接失败，guard仅负责兜底清理。 */
static int controller_run(int mode) {
    TestApis apis;
    HANDLE port = NULL, mapping = NULL, guard = NULL;
    HANDLE children[8] = { NULL };
    DWORD node_ids[2] = { 0, 0 };
    FILETIME node_created[2];
    HANDLE root_child = NULL;
    TestSharedState *shared = NULL;
    TestStartupInfoEx startup;
    PROCESS_INFORMATION parent;
    JOBOBJECT_EXTENDED_LIMIT_INFORMATION limits;
    SECURITY_ATTRIBUTES inheritable = { sizeof(SECURITY_ATTRIBUTES), NULL, TRUE };
    HANDLE inherited[2];
    FILETIME parent_created;
    WCHAR executable[32768], command[32768];
    DWORD start = GetTickCount(), child_count = 0, node_count = 0, parent_exit = 0, child_exit = 0, error = 0;
    DWORD observation_start = 0, setup_elapsed = 0, observation_elapsed = 0;
    DWORD child_wait_result = WAIT_FAILED, cleanup_error = ERROR_SUCCESS;
    const char *stage = "setup";
    const char *primary_stage;
    DWORD primary_error;
    LONG observed_phase = 0, creation_returned = 0, metadata_published = 0;
    void *attributes = NULL;
    BOOL stopped = FALSE, success = FALSE, limited = FALSE, active_zero = FALSE;
    BOOL observation_started = FALSE, observation_finished = FALSE;
    BOOL cleanup_verified = TRUE;
    memset(&apis, 0, sizeof(apis));
    memset(&parent, 0, sizeof(parent));
    limited = is_limited_parent();
    if (!limited || !load_apis(&apis)) goto cleanup;
    /* 外层guard仅包含本控制器创建的合成父；控制器死亡也会关闭此唯一清理句柄。 */
    guard = CreateJobObjectW(NULL, NULL);
    memset(&limits, 0, sizeof(limits));
    limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
    if (guard == NULL || !SetInformationJobObject(guard, JobObjectExtendedLimitInformation, &limits, sizeof(limits))) goto cleanup;
    port = CreateIoCompletionPort(INVALID_HANDLE_VALUE, NULL, 0, 1);
    mapping = CreateFileMappingW(INVALID_HANDLE_VALUE, &inheritable, PAGE_READWRITE, 0, sizeof(*shared), NULL);
    if (port == NULL || mapping == NULL || !SetHandleInformation(port, HANDLE_FLAG_INHERIT, HANDLE_FLAG_INHERIT)) goto cleanup;
    shared = MapViewOfFile(mapping, FILE_MAP_ALL_ACCESS, 0, 0, sizeof(*shared));
    if (shared == NULL) goto cleanup;
    memset(shared, 0, sizeof(*shared));
    inherited[0] = port; inherited[1] = mapping;
    attributes = attributes_create(&apis, 2);
    if (attributes == NULL || !apis.update(attributes, 0, TEST_ATTRIBUTE_JOB_LIST, &guard, sizeof(guard), NULL, NULL)
        || !apis.update(attributes, 0, TEST_ATTRIBUTE_HANDLE_LIST, inherited, sizeof(inherited), NULL, NULL)) goto cleanup;
    memset(&startup, 0, sizeof(startup));
    startup.startup.cb = sizeof(startup);
    startup.attributes = attributes;
    if (GetModuleFileNameW(NULL, executable, sizeof(executable) / sizeof(executable[0])) == 0) goto cleanup;
    if (_snwprintf(command, sizeof(command) / sizeof(command[0]), L"\"%ls\" parent %lu %lu %d", executable,
        (unsigned long)(ULONG_PTR)port, (unsigned long)(ULONG_PTR)mapping, mode) < 0) goto cleanup;
    if (!CreateProcessW(executable, command, NULL, NULL, TRUE,
        CREATE_SUSPENDED | CREATE_NO_WINDOW | EXTENDED_STARTUPINFO_PRESENT, NULL, AWR_PROJECT_ROOT,
        &startup.startup, &parent)) goto cleanup;
    if (!creation_identity(parent.hProcess, &parent_created)) goto cleanup;
    SetHandleInformation(port, HANDLE_FLAG_INHERIT, 0);
    SetHandleInformation(mapping, HANDLE_FLAG_INHERIT, 0);
    if (ResumeThread(parent.hThread) == (DWORD)-1) goto cleanup;
    CloseHandle(parent.hThread); parent.hThread = NULL;
    observation_start = GetTickCount();
    setup_elapsed = (DWORD)(observation_start - start);
    observation_started = TRUE;
    /* 仍以函数入口起算原10000ms总预算；分阶段计时只增加诊断，不重置或放宽等待上限。 */
    while ((DWORD)(GetTickCount() - start) < 10000) {
        DWORD message = 0;
        ULONG_PTR key = 0;
        OVERLAPPED *process_id = NULL;
        BOOL received = GetQueuedCompletionStatus(port, &message, &key, &process_id, 20);
        if (received && key != TEST_COMPLETION_KEY) { error = ERROR_INVALID_DATA; goto cleanup; }
        if (received && message == JOB_OBJECT_MSG_NEW_PROCESS) {
            HANDLE child;
            BOOL node;
            if (child_count >= sizeof(children) / sizeof(children[0])) { error = ERROR_INVALID_DATA; goto cleanup; }
            /* 通知仅来自父专用匿名job；核验过程中父活性再次读回，root由父真实句柄持有到ack。 */
            child = OpenProcess(SYNCHRONIZE | PROCESS_QUERY_LIMITED_INFORMATION, FALSE, (DWORD)(ULONG_PTR)process_id);
            if (child == NULL) goto cleanup;
            children[child_count++] = child;
            stage = "child-identity";
            if (!verify_child(&apis, child, parent.hProcess, guard, &parent_created, &node)) { error = ERROR_INVALID_DATA; goto cleanup; }
            if (node) {
                if (node_count >= 2) { error = ERROR_INVALID_DATA; goto cleanup; }
                node_ids[node_count] = (DWORD)(ULONG_PTR)process_id;
                if (!creation_identity(child, &node_created[node_count])) goto cleanup;
                if (node_count == 0) root_child = child;
                ++node_count;
            }
        }
        if (shared->error != 0) { error = (DWORD)shared->error; goto cleanup; }
        observed_phase = InterlockedCompareExchange(&shared->phase, 0, 0);
        creation_returned = InterlockedCompareExchange(&shared->creation_returned, 0, 0);
        if (node_count != 0 && observed_phase >= 2 && shared->root_acquired == 0) {
            if (node_ids[0] != shared->root_id || CompareFileTime(&node_created[0], &shared->root_creation) != 0) {
                error = ERROR_INVALID_DATA; goto cleanup;
            }
            InterlockedExchange(&shared->root_acquired, 1);
        }
        if (mode == 4 && shared->root_exited != 0) {
            if (root_child == NULL || WaitForSingleObject(root_child, 0) != WAIT_OBJECT_0) { error = ERROR_INVALID_DATA; goto cleanup; }
            InterlockedExchange(&shared->exit_acknowledged, 1);
            break;
        }
        if (node_count == (mode == 3 ? 2u : 1u)) {
            /* 创建成功后本模式固定停在phase1；其它阶段是协议错误，不能重试掩盖。 */
            if (mode == 1 && observed_phase != 1) {
                stage = "creation-phase";
                error = ERROR_INVALID_DATA;
                goto cleanup;
            }
            if ((mode == 1 && observed_phase == 1 && creation_returned != 0) ||
                (mode == 2 && observed_phase == 2) || (mode == 3 && observed_phase == 3)) {
                if (!TerminateProcess(parent.hProcess, 77)) goto cleanup;
                stopped = TRUE;
                break;
            }
        }
        if (WaitForSingleObject(parent.hProcess, 0) == WAIT_OBJECT_0 && mode != 4) { error = ERROR_PROCESS_ABORTED; goto cleanup; }
    }
    observation_elapsed = (DWORD)(GetTickCount() - observation_start);
    observation_finished = TRUE;
    stage = "window-observation";
    if ((mode != 4 && !stopped) || node_count != (mode == 3 ? 2u : 1u) || shared->inner_job_inherited) { error = ERROR_TIMEOUT; goto cleanup; }
    if (WaitForSingleObject(parent.hProcess, 5000) != WAIT_OBJECT_0 || !GetExitCodeProcess(parent.hProcess, &parent_exit)) goto cleanup;
    stage = "children-exit";
    for (DWORD index = 0; index < child_count; ++index) {
        child_wait_result = WaitForSingleObject(children[index], 5000);
        if (child_wait_result != WAIT_OBJECT_0) { error = wait_error(child_wait_result); goto cleanup; }
    }
    if (!GetExitCodeProcess(root_child, &child_exit)) goto cleanup;
    /* 内层最后句柄关闭时没有实证收到零通知，不能强求该消息或声称已观察。
     * 外层guard还打开且从未用于停止，仅作本次父/全部不可脱离后代的只读范围；ActiveProcesses为零证明没有剩余树。
     * 同时持有的Node/系统辅助句柄已逐个确认退出，避免只凭一个根退出推测整树结束。 */
    stage = "scoped-guard-active-zero";
    for (DWORD waited = 0; waited < 5000 && !active_zero; waited += 20) {
        JOBOBJECT_BASIC_ACCOUNTING_INFORMATION accounting;
        memset(&accounting, 0, sizeof(accounting));
        if (!QueryInformationJobObject(guard, JobObjectBasicAccountingInformation, &accounting, sizeof(accounting), NULL)) goto cleanup;
        active_zero = accounting.ActiveProcesses == 0;
        if (!active_zero) Sleep(20);
    }
    if (!active_zero) { error = ERROR_TIMEOUT; goto cleanup; }
    stage = "exit-code";
    if (mode == 4 && (parent_exit != TEST_EXIT_CODE || child_exit != TEST_EXIT_CODE)) { error = ERROR_INVALID_DATA; goto cleanup; }
    success = TRUE;
cleanup:
    if (!success && error == 0) error = GetLastError() != 0 ? GetLastError() : ERROR_INVALID_DATA;
    primary_stage = stage;
    primary_error = error;
    /* 在失败兜底清理前固定观测数据；清理等待不能混入setup或observation耗时。 */
    if (!observation_started) setup_elapsed = (DWORD)(GetTickCount() - start);
    else if (!observation_finished) observation_elapsed = (DWORD)(GetTickCount() - observation_start);
    if (shared != NULL) {
        observed_phase = InterlockedCompareExchange(&shared->phase, 0, 0);
        creation_returned = InterlockedCompareExchange(&shared->creation_returned, 0, 0);
        metadata_published = InterlockedCompareExchange(&shared->metadata_published, 0, 0);
    }
    /* 失败只操作本次已持父句柄和guard；不存在按编号、名称或命令全机扫描/终止的补偿路径。
     * 父及各子仍只使用原5000ms清理预算，但确认放在guard关闭后，不能仅凭发出终止就声称已退出。 */
    if (!success && parent.hProcess != NULL && WaitForSingleObject(parent.hProcess, 0) != WAIT_OBJECT_0) {
        TerminateProcess(parent.hProcess, 78);
    }
    if (guard != NULL && !CloseHandle(guard)) {
        cleanup_error = GetLastError();
        cleanup_verified = FALSE;
    }
    if (parent.hProcess != NULL) {
        DWORD waited = WaitForSingleObject(parent.hProcess, success ? 0 : 5000);
        if (waited != WAIT_OBJECT_0) {
            cleanup_error = wait_error(waited);
            cleanup_verified = FALSE;
        }
    }
    for (DWORD index = 0; index < child_count; ++index) {
        DWORD waited = WaitForSingleObject(children[index], success ? 0 : 5000);
        if (waited != WAIT_OBJECT_0) {
            cleanup_error = wait_error(waited);
            cleanup_verified = FALSE;
        }
        CloseHandle(children[index]);
    }
    if (parent.hThread != NULL) CloseHandle(parent.hThread);
    if (parent.hProcess != NULL) CloseHandle(parent.hProcess);
    if (attributes != NULL) { apis.destroy(attributes); free(attributes); }
    if (shared != NULL) UnmapViewOfFile(shared);
    if (mapping != NULL) CloseHandle(mapping);
    if (port != NULL) CloseHandle(port);
    /* 原始断言失败与清理失败分开报告；负例不能把未确认清理的超时接受为预期成功。 */
    if (!cleanup_verified) {
        success = FALSE;
        stage = "cleanup-failed";
        error = cleanup_error != ERROR_SUCCESS ? cleanup_error : ERROR_INVALID_DATA;
    }
    if (!success) { fprintf(stderr, "fixture-failed stage=%s mode=%d error=%lu phase=%ld children=%lu parentExit=%lu childExit=%lu creationReturned=%ld metadataPublished=%ld setupElapsedMs=%lu observationElapsedMs=%lu nodeCount=%lu childWaitResult=%lu cleanupVerified=%s primaryStage=%s primaryError=%lu\n",
        stage, mode, (unsigned long)error, (long)observed_phase, (unsigned long)child_count,
        (unsigned long)parent_exit, (unsigned long)child_exit, (long)creation_returned, (long)metadata_published,
        (unsigned long)setup_elapsed, (unsigned long)observation_elapsed, (unsigned long)node_count,
        (unsigned long)child_wait_result, cleanup_verified ? "true" : "false", primary_stage, (unsigned long)primary_error); return 1; }
    printf("{\"evidence\":\"real-job-limited-fixture-not-s4u\",\"pointerBits\":%u,\"limitedParent\":true,"
        "\"childImageVerified\":true,\"creationIdentityVerified\":true,\"parentAliveDuringAcquisition\":true,\"guardOpenDuringAssertions\":true,"
        "\"scopedGuardActiveZero\":true,"
        "\"childrenExited\":true,\"innerJobInherited\":false,\"unknownProcessesScanned\":false,"
        "\"parentStoppedViaHeldHandle\":%s,\"phase\":%ld,\"creationReturned\":%s,\"metadataPublished\":%s,\"setupElapsedMs\":%lu,\"observationElapsedMs\":%lu,\"childCount\":%lu,\"nodeCount\":%lu,\"systemHelperCount\":%lu,\"attempt\":1,"
        "\"childWaitResult\":%lu,\"cleanupVerified\":%s,"
        "\"parentExitCode\":%lu,\"childExitCode\":%lu}\n", (unsigned int)(sizeof(void *) * 8), stopped ? "true" : "false",
        (long)observed_phase, creation_returned != 0 ? "true" : "false", metadata_published != 0 ? "true" : "false",
        (unsigned long)setup_elapsed, (unsigned long)observation_elapsed, (unsigned long)child_count,
        (unsigned long)node_count, (unsigned long)(child_count - node_count),
        (unsigned long)child_wait_result, cleanup_verified ? "true" : "false", (unsigned long)parent_exit, (unsigned long)child_exit);
    return 0;
}

/** 夹具入口只接受本测试固定模式或内部父IPC值；与生产入口及真实计划任务完全分离。 */
int main(int argc, char **argv) {
    int mode = 0;
    if (argc == 5 && strcmp(argv[1], "parent") == 0) {
        DWORD result = parent_run((HANDLE)(ULONG_PTR)strtoul(argv[2], NULL, 10),
            (HANDLE)(ULONG_PTR)strtoul(argv[3], NULL, 10), atoi(argv[4]));
        ExitProcess(result);
    }
    if (argc != 2) return 2;
    if (strcmp(argv[1], "creation") == 0) mode = 1;
    if (strcmp(argv[1], "before-resume") == 0) mode = 2;
    if (strcmp(argv[1], "waiting") == 0) mode = 3;
    if (strcmp(argv[1], "exit-code") == 0) mode = 4;
    if (mode == 0) return 2;
    return controller_run(mode);
}
