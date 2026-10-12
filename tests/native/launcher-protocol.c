/*
 * 仅测试编译单元中的Windows接口替身：直接包含未加测试开关的生产源码。
 * 所有令牌/进程/线程/作业变更调用均在这里映射，不创建真实服务、任务或高权限主体。
 * 安全标识符、描述符解析和缓冲布局仍使用本机只读系统接口，不能把协议替身称为S4U真实验收。
 */
#define _WIN32_WINNT 0x0A00
#define WIN32_LEAN_AND_MEAN
#include <windows.h>
#include <aclapi.h>
#include <sddl.h>
#include <tlhelp32.h>
#include <stdio.h>
#include <stdlib.h>
#include <stddef.h>
#include <stdint.h>
#include <string.h>
#include <wchar.h>
#include "background-binding.h"

#ifndef THREAD_QUERY_LIMITED_INFORMATION
#define THREAD_QUERY_LIMITED_INFORMATION 0x0800
#endif
#ifndef TOKEN_ADJUST_SESSIONID
#define TOKEN_ADJUST_SESSIONID 0x0100
#endif
#define F_EXIT_CODE ((DWORD)0xf1234567)
#define F_JOB_ATTRIBUTE ((DWORD_PTR)0x0002000d)
#define F_EXTENDED_STARTUPINFO 0x00080000
#ifndef SDDL_REVISION_1
#define SDDL_REVISION_1 1
/* 本机旧头缺失的官方只读转换声明；链接现有系统接口，不安装新库。 */
__declspec(dllimport) BOOL WINAPI ConvertStringSecurityDescriptorToSecurityDescriptorW(LPCWSTR, DWORD, PSECURITY_DESCRIPTOR *, PULONG);
#endif

enum FKind { F_NONE, F_PARENT, F_THREAD, F_TOKEN, F_SNAPSHOT, F_JOB, F_CHILD, F_CHILD_THREAD };
enum FFailure {
    F_OK, F_SELF_PATH, F_EXISTING_IMPERSONATION, F_PARENT_USER, F_PARENT_SESSION,
    F_PARENT_LABEL, F_DESCRIPTOR_QUERY, F_DESCRIPTOR_LOW, F_DESCRIPTOR_NO_DACL,
    F_DESCRIPTOR_NO_LABEL, F_NOTIFY_LOOKUP, F_RESTRICTED_CREATE, F_SET_LABEL,
    F_LIMITED_ENABLED_GROUP, F_LIMITED_EXTRA_PRIVILEGE, F_LIMITED_ADMIN,
    F_THREAD_IDENTITY, F_ACCESS_GRANTED, F_ACCESS_UNKNOWN_ERROR, F_SET_THREAD,
    F_REVERT, F_RESIDUAL_TOKEN, F_ENVIRONMENT, F_EXPORT, F_MODULE_PATH,
    F_JOB_CREATE, F_JOB_LIMIT, F_ATTRIBUTE_PROBE, F_ATTRIBUTE_SIZE, F_ATTRIBUTE_INIT,
    F_ATTRIBUTE_UPDATE, F_CREATE_CHILD, F_CHILD_NOT_JOB, F_CHILD_JOB_QUERY,
    F_CHILD_TOKEN_OPEN, F_CHILD_BAD_TOKEN, F_CHILD_IDENTITY, F_PARENT_RECHECK,
    F_RESUME, F_RESUME_COUNT, F_WAIT, F_WAIT_UNKNOWN, F_EXIT_QUERY, F_QUERY_PROBE,
    F_QUERY_LENGTH, F_QUERY_BUFFER_SID, F_HEAP_FAIL, F_PARENT_POLICY, F_LIMITED_POLICY,
    F_DUPLICATE_ROLE, F_CHILD_GROUP_ATTRIBUTE, F_CHILD_PRIVILEGE_ATTRIBUTE,
    F_CHILD_LOGON_GROUP, F_THREAD_GROUP_ATTRIBUTE, F_LIMITED_INTEGRITY_GROUP,
    F_DUPLICATE_ACCESS, F_PARENT_CREATION_CHANGED, F_THREAD_CREATION_CHANGED, F_PARENT_TOKEN_ID_CHANGED,
    F_TWO_THREADS, F_ACCESS_GRANTED_SECOND, F_ACCESS_UNKNOWN_SECOND, F_HEAP_FAIL_SECOND
};

typedef struct {
    PSID user;
    TOKEN_TYPE type;
    DWORD session, integrity, group_count, privilege_count;
    PSID groups[16];
    DWORD attributes[16];
    LUID_AND_ATTRIBUTES privileges[8];
    LUID token_id, authentication_id;
} FToken;
typedef struct { enum FKind kind; BOOL live; DWORD id, enumeration_index; FToken token; } FHandle;
typedef struct { STARTUPINFOW startup; void *attributes; } FStartup;

static FHandle f_handles[512];
static void *f_allocations[512];
static void *f_descriptors[128];
static PSID f_user, f_wrong_user, f_sids[16], f_medium, f_high;
static DWORD f_sid_count;
static FToken f_original, f_limited;
static enum FFailure f_failure;
static DWORD f_next_handle, f_active_handles, f_allocated, f_descriptor_count, f_contract_errors;
static DWORD f_restricted_calls, f_create_calls, f_resume_calls, f_terminate_calls, f_wait_calls;
static DWORD f_delete_attributes, f_revert_calls, f_right_index, f_fail_right;
static DWORD f_process_rights, f_thread_rights, f_token_rights, f_environment_entries;
static DWORD f_allocation_attempts, f_fail_allocation;
static DWORD f_thread_count, f_duplicate_calls, f_last_reallocation_attempt;
static BOOL f_impersonating, f_child_created, f_child_terminated, f_job_closed;
static BOOL f_filtered_lists, f_job_noninherited, f_job_limit, f_environment_clean;
static BOOL f_attribute_ready, f_attribute_job, f_waited_unique;
static HANDLE f_job_handle, f_child_handle;

/** 记录夹具协议断言；运行全组并输出实际失败数，而非只通过编译。 */
static void f_require(BOOL condition, const char *name) {
    if (!condition) { ++f_contract_errors; fprintf(stderr, "protocol-contract=%s\n", name); }
}

/** 以独立编号建立纯内存替身句柄，绝不把这些值传给未映射的变更系统接口。 */
static HANDLE f_new_handle(enum FKind kind, const FToken *token) {
    DWORD index = ++f_next_handle;
    if (index >= sizeof(f_handles) / sizeof(f_handles[0])) { f_require(FALSE, "handle-capacity"); return NULL; }
    f_handles[index].kind = kind;
    f_handles[index].live = TRUE;
    if (token != NULL) f_handles[index].token = *token;
    ++f_active_handles;
    return (HANDLE)(ULONG_PTR)index;
}

/** 检查纯内存句柄类型及存活；未知句柄是测试失败，不映射到现场对象。 */
static FHandle *f_handle(HANDLE value) {
    DWORD index = (DWORD)(ULONG_PTR)value;
    if (index == 0 || index > f_next_handle || !f_handles[index].live) { f_require(FALSE, "stable-live-handle"); return NULL; }
    return &f_handles[index];
}

/** 包装本进程堆分配，逐场景验证生产缓冲释放；不改变生产代码的分配接口。 */
static LPVOID WINAPI f_HeapAlloc(HANDLE heap, DWORD flags, SIZE_T size) {
    if (++f_allocation_attempts == f_fail_allocation && (f_failure == F_HEAP_FAIL || f_failure == F_HEAP_FAIL_SECOND)) {
        SetLastError(ERROR_NOT_ENOUGH_MEMORY); return NULL;
    }
    void *result = HeapAlloc(heap, flags, size);
    if (result == NULL) return NULL;
    for (DWORD i = 0; i < 512; ++i) if (f_allocations[i] == NULL) { f_allocations[i] = result; ++f_allocated; return result; }
    f_require(FALSE, "heap-capacity"); HeapFree(heap, 0, result); return NULL;
}

/** 在替身统计中更新重分配后的稳定缓冲归属。 */
static LPVOID WINAPI f_HeapReAlloc(HANDLE heap, DWORD flags, LPVOID old, SIZE_T size) {
    f_last_reallocation_attempt = ++f_allocation_attempts;
    if (f_allocation_attempts == f_fail_allocation && (f_failure == F_HEAP_FAIL || f_failure == F_HEAP_FAIL_SECOND)) {
        SetLastError(ERROR_NOT_ENOUGH_MEMORY); return NULL;
    }
    for (DWORD i = 0; i < 512; ++i) if (f_allocations[i] == old) {
        void *result = HeapReAlloc(heap, flags, old, size);
        if (result != NULL) f_allocations[i] = result;
        return result;
    }
    f_require(FALSE, "realloc-owned-buffer"); return NULL;
}

/** 释放前核对本场景缓冲，捕获遗漏restricted_data及重复释放。 */
static BOOL WINAPI f_HeapFree(HANDLE heap, DWORD flags, LPVOID buffer) {
    for (DWORD i = 0; i < 512; ++i) if (f_allocations[i] == buffer) {
        f_allocations[i] = NULL; --f_allocated; return HeapFree(heap, flags, buffer);
    }
    f_require(FALSE, "free-owned-buffer"); return FALSE;
}

/** 描述符使用真实解析结果，仅跟踪返回给生产的独立系统分配。 */
static HLOCAL WINAPI f_LocalFree(HLOCAL buffer) {
    for (DWORD i = 0; i < 128; ++i) if (f_descriptors[i] == buffer) { f_descriptors[i] = NULL; --f_descriptor_count; break; }
    return LocalFree(buffer);
}

/** 结束纯内存句柄，并记录唯一作业关闭顺序；无真实进程终止动作。 */
static BOOL WINAPI f_CloseHandle(HANDLE value) {
    FHandle *handle = f_handle(value);
    if (handle == NULL) return FALSE;
    if (handle->kind == F_JOB) f_job_closed = TRUE;
    handle->live = FALSE; --f_active_handles; return TRUE;
}

/** 将真实安全标识符完整复制进本次令牌返回缓冲，禁止把全局指针冒充系统有界返回。 */
static PSID f_pack_sid(BYTE **cursor, PSID sid) {
    DWORD size = GetLengthSid(sid);
    PSID target = *cursor;
    memcpy(target, sid, size); *cursor += size; return target;
}

/** 令牌信息替身保留真实Windows布局、探测错误及有界长度；负面场景专门破坏协议。 */
static BOOL WINAPI f_GetTokenInformation(HANDLE value, TOKEN_INFORMATION_CLASS kind, LPVOID buffer, DWORD size, PDWORD actual) {
    FHandle *handle = f_handle(value);
    FToken *token;
    DWORD required = 0;
    BYTE *cursor;
    if (handle == NULL || handle->kind != F_TOKEN) return FALSE;
    token = &handle->token;
    switch (kind) {
        case TokenUser: required = sizeof(TOKEN_USER) + GetLengthSid(token->user); break;
        case TokenGroups:
            required = offsetof(TOKEN_GROUPS, Groups) + token->group_count * sizeof(SID_AND_ATTRIBUTES);
            for (DWORD i = 0; i < token->group_count; ++i) required += GetLengthSid(token->groups[i]);
            break;
        case TokenPrivileges: required = offsetof(TOKEN_PRIVILEGES, Privileges) + token->privilege_count * sizeof(LUID_AND_ATTRIBUTES); break;
        case TokenIntegrityLevel: required = sizeof(TOKEN_MANDATORY_LABEL) + GetLengthSid(token->integrity == SECURITY_MANDATORY_HIGH_RID ? f_high : f_medium); break;
        case TokenRestrictedSids: required = offsetof(TOKEN_GROUPS, Groups); break;
        case TokenType: required = sizeof(TOKEN_TYPE); break;
        case TokenSessionId: required = sizeof(DWORD); break;
        case TokenStatistics: required = sizeof(TOKEN_STATISTICS); break;
        case TokenMandatoryPolicy: required = sizeof(TOKEN_MANDATORY_POLICY); break;
        case TokenImpersonationLevel: required = sizeof(SECURITY_IMPERSONATION_LEVEL); break;
        default: SetLastError(ERROR_INVALID_PARAMETER); return FALSE;
    }
    *actual = required;
    if (buffer == NULL || size < required) {
        if (f_failure == F_QUERY_PROBE && kind == TokenUser) { SetLastError(ERROR_SUCCESS); return TRUE; }
        SetLastError(ERROR_INSUFFICIENT_BUFFER); return FALSE;
    }
    memset(buffer, 0, required);
    switch (kind) {
        case TokenUser:
            cursor = (BYTE *)buffer + sizeof(TOKEN_USER);
            ((TOKEN_USER *)buffer)->User.Sid = f_pack_sid(&cursor, token->user);
            if (f_failure == F_QUERY_BUFFER_SID) ((TOKEN_USER *)buffer)->User.Sid = f_user;
            break;
        case TokenGroups:
            ((TOKEN_GROUPS *)buffer)->GroupCount = token->group_count;
            cursor = (BYTE *)buffer + offsetof(TOKEN_GROUPS, Groups) + token->group_count * sizeof(SID_AND_ATTRIBUTES);
            for (DWORD i = 0; i < token->group_count; ++i) {
                ((TOKEN_GROUPS *)buffer)->Groups[i].Sid = f_pack_sid(&cursor, token->groups[i]);
                ((TOKEN_GROUPS *)buffer)->Groups[i].Attributes = token->attributes[i];
            }
            break;
        case TokenPrivileges:
            ((TOKEN_PRIVILEGES *)buffer)->PrivilegeCount = token->privilege_count;
            memcpy(((TOKEN_PRIVILEGES *)buffer)->Privileges, token->privileges, token->privilege_count * sizeof(LUID_AND_ATTRIBUTES)); break;
        case TokenIntegrityLevel:
            cursor = (BYTE *)buffer + sizeof(TOKEN_MANDATORY_LABEL);
            ((TOKEN_MANDATORY_LABEL *)buffer)->Label.Sid = f_pack_sid(&cursor, token->integrity == SECURITY_MANDATORY_HIGH_RID ? f_high : f_medium);
            ((TOKEN_MANDATORY_LABEL *)buffer)->Label.Attributes = SE_GROUP_INTEGRITY; break;
        case TokenRestrictedSids: ((TOKEN_GROUPS *)buffer)->GroupCount = 0; break;
        case TokenType: *(TOKEN_TYPE *)buffer = token->type; break;
        case TokenSessionId: *(DWORD *)buffer = token->session; break;
        case TokenStatistics:
            ((TOKEN_STATISTICS *)buffer)->TokenId = token->token_id;
            ((TOKEN_STATISTICS *)buffer)->AuthenticationId = token->authentication_id;
            ((TOKEN_STATISTICS *)buffer)->TokenType = token->type; break;
        case TokenMandatoryPolicy:
            ((TOKEN_MANDATORY_POLICY *)buffer)->Policy =
                (f_failure == F_PARENT_POLICY && token->integrity == SECURITY_MANDATORY_HIGH_RID) ||
                (f_failure == F_LIMITED_POLICY && token->integrity == SECURITY_MANDATORY_MEDIUM_RID) ? 0 : TOKEN_MANDATORY_POLICY_NO_WRITE_UP;
            break;
        case TokenImpersonationLevel: *(SECURITY_IMPERSONATION_LEVEL *)buffer = SecurityImpersonation; break;
        default: break;
    }
    if (f_failure == F_QUERY_LENGTH && kind == TokenUser) *actual = required + 1;
    SetLastError(ERROR_SUCCESS); return TRUE;
}

/** 固定原用户主令牌只在替身内复制；显式组/特权删除列表逐项校验，原模型前后不能被改写。 */
static BOOL WINAPI f_CreateRestrictedToken(HANDLE existing, DWORD flags, DWORD deny_count, PSID_AND_ATTRIBUTES deny,
    DWORD remove_count, PLUID_AND_ATTRIBUTES remove, DWORD restricted_count, PSID_AND_ATTRIBUTES restricted, PHANDLE output) {
    FHandle *original = f_handle(existing);
    BOOL seen[3] = { FALSE, FALSE, FALSE };
    ++f_restricted_calls;
    f_require(original != NULL && original->kind == F_TOKEN, "restricted-source-token");
    f_require(flags == 0 && restricted_count == 0 && restricted == NULL, "restricted-flags-and-explicit-empty-list");
    f_require(deny_count == 3 && remove_count == 3, "deny-three-unknown-groups-and-remove-all-extra-privileges");
    if (original == NULL) return FALSE;
    for (DWORD i = 0; i < deny_count; ++i) {
        f_require(deny[i].Attributes == 0, "deny-list-initialized-attributes");
        for (DWORD j = 0; j < 3; ++j) if (EqualSid(deny[i].Sid, f_sids[f_sid_count - 3 + j])) seen[j] = TRUE;
    }
    f_require(seen[0] && seen[1] && seen[2], "deny-list-exact-unknown-set");
    memset(seen, 0, sizeof(seen));
    for (DWORD i = 0; i < remove_count; ++i) {
        f_require(remove[i].Luid.LowPart != 23 && remove[i].Luid.HighPart == 0 && remove[i].Attributes == 0, "remove-list-no-notify-and-zero-attributes");
        for (DWORD j = 0; j < 3; ++j) if (remove[i].Luid.LowPart == 11 + j) seen[j] = TRUE;
    }
    f_require(seen[0] && seen[1] && seen[2], "remove-list-exact-extra-privileges-including-disabled");
    f_filtered_lists = f_contract_errors == 0;
    if (f_failure == F_RESTRICTED_CREATE) { SetLastError(ERROR_PRIVILEGE_NOT_HELD); return FALSE; }
    f_limited = original->token;
    f_limited.token_id.LowPart = 12;
    for (DWORD i = f_limited.group_count - 3; i < f_limited.group_count; ++i) f_limited.attributes[i] = SE_GROUP_USE_FOR_DENY_ONLY;
    f_limited.privilege_count = 1;
    f_limited.privileges[0].Luid.LowPart = 23;
    f_limited.privileges[0].Luid.HighPart = 0;
    f_limited.privileges[0].Attributes = SE_PRIVILEGE_ENABLED;
    if (f_failure == F_LIMITED_ENABLED_GROUP) f_limited.attributes[f_limited.group_count - 1] |= SE_GROUP_ENABLED;
    if (f_failure == F_LIMITED_EXTRA_PRIVILEGE) { f_limited.privilege_count = 2; f_limited.privileges[1].Luid.LowPart = 20; }
    *output = f_new_handle(F_TOKEN, &f_limited); return *output != NULL;
}

/** 降低完整性调用只修改纯内存新令牌，要求精确中等标识和长度。 */
static BOOL WINAPI f_SetTokenInformation(HANDLE value, TOKEN_INFORMATION_CLASS kind, LPVOID data, DWORD length) {
    FHandle *handle = f_handle(value);
    TOKEN_MANDATORY_LABEL *label = data;
    f_require(handle != NULL && kind == TokenIntegrityLevel && label != NULL, "only-new-token-integrity-set");
    f_require(EqualSid(label->Label.Sid, f_medium) && label->Label.Attributes == SE_GROUP_INTEGRITY &&
        length == sizeof(*label) + GetLengthSid(f_medium), "exact-medium-integrity-set");
    if (f_failure == F_SET_LABEL) { SetLastError(ERROR_ACCESS_DENIED); return FALSE; }
    handle->token.integrity = SECURITY_MANDATORY_MEDIUM_RID;
    handle->token.groups[0] = f_failure == F_LIMITED_INTEGRITY_GROUP ? f_high : f_medium;
    f_limited = handle->token; return TRUE;
}

/** 主令牌管理员检查及访问探测都复制同一有限主体为模拟令牌，不替换成较弱令牌。 */
static BOOL WINAPI f_DuplicateTokenEx(HANDLE value, DWORD rights, LPSECURITY_ATTRIBUTES attributes,
    SECURITY_IMPERSONATION_LEVEL level, TOKEN_TYPE type, PHANDLE output) {
    FHandle *original = f_handle(value);
    FToken copy;
    ++f_duplicate_calls;
    f_require(original != NULL && original->kind == F_TOKEN && attributes == NULL &&
        rights == (TOKEN_QUERY | TOKEN_IMPERSONATE) && level == SecurityImpersonation && type == TokenImpersonation,
        "query-impersonation-duplicate-contract");
    if (original == NULL) return FALSE;
    if (f_failure == F_DUPLICATE_ROLE || (f_failure == F_DUPLICATE_ACCESS && f_duplicate_calls == 2)) {
        SetLastError(ERROR_ACCESS_DENIED); return FALSE;
    }
    copy = original->token; copy.type = type; *output = f_new_handle(F_TOKEN, &copy); return *output != NULL;
}

/** 管理员角色接口必须使用实际模拟型查询句柄，原主令牌直接传入即使测试失败。 */
static BOOL WINAPI f_CheckTokenMembership(HANDLE value, PSID administrators, PBOOL member) {
    FHandle *handle = f_handle(value);
    f_require(handle != NULL && handle->kind == F_TOKEN && handle->token.type == TokenImpersonation,
        "membership-not-primary-token");
    f_require(EqualSid(administrators, f_sids[f_sid_count - 3]), "membership-admin-sid");
    *member = f_failure == F_LIMITED_ADMIN; return TRUE;
}

/** 安全描述符以真实解析器生成；只给替身内核对象读回，分别注入查询失败、低标签和缺失字段。 */
static DWORD WINAPI f_GetSecurityInfo(HANDLE value, SE_OBJECT_TYPE kind, SECURITY_INFORMATION information,
    PSID *owner, PSID *group, PACL *dacl, PACL *sacl, PSECURITY_DESCRIPTOR *descriptor) {
    LPCWSTR text = L"O:SYD:(A;;GA;;;SY)S:(ML;;NW;;;HI)";
    BOOL present, defaulted;
    f_require(f_handle(value) != NULL && kind == SE_KERNEL_OBJECT && group == NULL &&
        information == (OWNER_SECURITY_INFORMATION | DACL_SECURITY_INFORMATION | LABEL_SECURITY_INFORMATION), "readonly-object-query");
    if (f_failure == F_DESCRIPTOR_QUERY) return ERROR_ACCESS_DENIED;
    if (f_failure == F_DESCRIPTOR_LOW || (f_failure == F_PARENT_RECHECK && f_child_created)) text = L"O:SYD:(A;;GA;;;SY)S:(ML;;NW;;;ME)";
    if (f_failure == F_DESCRIPTOR_NO_DACL) text = L"O:SYS:(ML;;NW;;;HI)";
    if (f_failure == F_DESCRIPTOR_NO_LABEL) text = L"O:SYD:(A;;GA;;;SY)S:(AU;SA;GA;;;SY)";
    if (!ConvertStringSecurityDescriptorToSecurityDescriptorW(text, SDDL_REVISION_1, descriptor, NULL)) return GetLastError();
    for (DWORD i = 0; i < 128; ++i) if (f_descriptors[i] == NULL) { f_descriptors[i] = *descriptor; ++f_descriptor_count; break; }
    if (!GetSecurityDescriptorOwner(*descriptor, owner, &defaulted) ||
        !GetSecurityDescriptorDacl(*descriptor, &present, dacl, &defaulted) ||
        !GetSecurityDescriptorSacl(*descriptor, &present, sacl, &defaulted)) return ERROR_INVALID_DATA;
    return ERROR_SUCCESS;
}

/** 一个危险位在真正模拟时计数；只有访问拒绝是合格，成功或其它错误按指定序号注入。 */
static BOOL f_dangerous_request(DWORD rights, DWORD *count) {
    static const DWORD process_bits[] = { PROCESS_CREATE_THREAD, PROCESS_VM_OPERATION, PROCESS_VM_WRITE, PROCESS_DUP_HANDLE,
        PROCESS_CREATE_PROCESS, PROCESS_SET_INFORMATION, PROCESS_SET_QUOTA, PROCESS_SUSPEND_RESUME, PROCESS_TERMINATE, WRITE_DAC, WRITE_OWNER };
    static const DWORD thread_bits[] = { THREAD_SET_CONTEXT, THREAD_IMPERSONATE, THREAD_DIRECT_IMPERSONATION,
        THREAD_SET_INFORMATION, THREAD_SUSPEND_RESUME, THREAD_TERMINATE, WRITE_DAC, WRITE_OWNER };
    static const DWORD token_bits[] = { TOKEN_DUPLICATE, TOKEN_IMPERSONATE, TOKEN_ASSIGN_PRIMARY, TOKEN_ADJUST_PRIVILEGES,
        TOKEN_ADJUST_GROUPS, TOKEN_ADJUST_DEFAULT, TOKEN_ADJUST_SESSIONID, WRITE_DAC, WRITE_OWNER };
    BOOL selected = f_right_index++ == f_fail_right;
    /* 数量相同不代表位集合相同；对照批准的精确有序单权限位，防止重复某位掩盖漏测另一位。 */
    if (count == &f_process_rights) f_require(*count < 11 && rights == process_bits[*count], "exact-process-danger-rights");
    else if (count == &f_thread_rights) f_require(*count < 8 * f_thread_count && rights == thread_bits[*count % 8], "exact-all-thread-danger-rights");
    else if (count == &f_token_rights) f_require(*count < 9 && rights == token_bits[*count], "exact-token-danger-rights");
    else f_require(FALSE, "known-danger-right-class");
    f_require(f_impersonating && rights != 0 && (rights & (rights - 1)) == 0, "individual-danger-bit-in-limited-context");
    ++*count;
    if (selected && (f_failure == F_ACCESS_GRANTED || f_failure == F_ACCESS_GRANTED_SECOND)) return TRUE;
    SetLastError(selected && (f_failure == F_ACCESS_UNKNOWN_ERROR || f_failure == F_ACCESS_UNKNOWN_SECOND) ? ERROR_INVALID_PARAMETER : ERROR_ACCESS_DENIED);
    return FALSE;
}

/** 父进程新开只读句柄和危险单权限请求分开；绝不扫描现场进程。 */
static HANDLE WINAPI f_OpenProcess(DWORD rights, BOOL inherit, DWORD id) {
    f_require(!inherit && id == 101, "bound-parent-process-id");
    if (rights == (READ_CONTROL | PROCESS_QUERY_LIMITED_INFORMATION) || rights == PROCESS_QUERY_LIMITED_INFORMATION)
        return f_new_handle(F_PARENT, NULL);
    return f_dangerous_request(rights, &f_process_rights) ? f_new_handle(F_PARENT, NULL) : NULL;
}

/** 固定父线程新开只读句柄与各危险位分开，逐位错误不近似成访问拒绝。 */
static HANDLE WINAPI f_OpenThread(DWORD rights, BOOL inherit, DWORD id) {
    HANDLE thread;
    f_require(!inherit && (id == 201 || (f_thread_count == 2 && id == 202)), "bound-parent-thread-id");
    if (rights == (READ_CONTROL | THREAD_QUERY_LIMITED_INFORMATION) || rights == THREAD_QUERY_LIMITED_INFORMATION) {
        thread = f_new_handle(F_THREAD, NULL); f_handle(thread)->id = id; return thread;
    }
    return f_dangerous_request(rights, &f_thread_rights) ? f_new_handle(F_THREAD, NULL) : NULL;
}

/** 仅从本次父或子查询令牌；受限访问探测不得借用高权限父令牌句柄。 */
static BOOL WINAPI f_OpenProcessToken(HANDLE value, DWORD rights, PHANDLE output) {
    FHandle *process = f_handle(value);
    FToken token;
    *output = NULL;
    if (process == NULL) return FALSE;
    if (process->kind == F_CHILD) {
        f_require(rights == (TOKEN_QUERY | TOKEN_DUPLICATE), "suspended-child-query-rights");
        if (f_failure == F_CHILD_TOKEN_OPEN) { SetLastError(ERROR_ACCESS_DENIED); return FALSE; }
        token = f_limited;
        if (f_failure == F_CHILD_BAD_TOKEN) token.user = f_wrong_user;
        if (f_failure == F_CHILD_IDENTITY) ++token.authentication_id.LowPart;
        if (f_failure == F_CHILD_GROUP_ATTRIBUTE) token.attributes[0] ^= SE_GROUP_MANDATORY;
        if (f_failure == F_CHILD_PRIVILEGE_ATTRIBUTE) token.privileges[0].Attributes = 0;
        if (f_failure == F_CHILD_LOGON_GROUP) token.groups[token.group_count - 4] = f_wrong_user;
        *output = f_new_handle(F_TOKEN, &token); return TRUE;
    }
    f_require(process->kind == F_PARENT, "process-token-parent-kind");
    if (f_impersonating && rights != TOKEN_QUERY) {
        if (!f_dangerous_request(rights, &f_token_rights)) return FALSE;
    }
    token = f_original;
    if (f_failure == F_PARENT_TOKEN_ID_CHANGED && f_impersonating) ++token.token_id.LowPart;
    *output = f_new_handle(F_TOKEN, &token); return TRUE;
}

/** 读取真实模拟方替身，OpenAsSelf只允许查询；残留模拟和主体不一致分别关闭协议。 */
static BOOL WINAPI f_OpenThreadToken(HANDLE thread, DWORD rights, BOOL as_self, PHANDLE output) {
    FToken token = f_limited;
    (void)thread;
    f_require(rights == TOKEN_QUERY && as_self, "thread-token-readonly-open-as-self");
    *output = NULL;
    if (f_failure == F_EXISTING_IMPERSONATION && f_restricted_calls == 0) {
        token = f_original; token.type = TokenImpersonation; *output = f_new_handle(F_TOKEN, &token); return TRUE;
    }
    if (!f_impersonating && !(f_failure == F_RESIDUAL_TOKEN && f_revert_calls != 0)) { SetLastError(ERROR_NO_TOKEN); return FALSE; }
    token.type = TokenImpersonation;
    if (f_failure == F_THREAD_IDENTITY) ++token.authentication_id.LowPart;
    if (f_failure == F_THREAD_GROUP_ATTRIBUTE) token.attributes[0] ^= SE_GROUP_MANDATORY;
    *output = f_new_handle(F_TOKEN, &token); return TRUE;
}

/** 仅改变替身线程模拟状态，记录设置失败后仍必须恢复。 */
static BOOL WINAPI f_SetThreadToken(PHANDLE thread, HANDLE token) {
    FHandle *handle = f_handle(token);
    f_require(thread == NULL && handle != NULL && handle->token.type == TokenImpersonation, "set-exact-impersonation");
    if (f_failure == F_SET_THREAD) { SetLastError(ERROR_ACCESS_DENIED); return FALSE; }
    f_impersonating = TRUE; return TRUE;
}

/** 恢复原始无模拟状态；接口失败必须阻止服务创建，不能被当成成功。 */
static BOOL WINAPI f_RevertToSelf(void) {
    ++f_revert_calls;
    if (f_failure == F_REVERT) { SetLastError(ERROR_ACCESS_DENIED); return FALSE; }
    f_impersonating = FALSE; return TRUE;
}

/** 线程枚举只返回本场景合成父的一至两条固定记录，不访问全机进程表。 */
static HANDLE WINAPI f_CreateToolhelp32Snapshot(DWORD flags, DWORD id) {
    f_require(flags == TH32CS_SNAPTHREAD && id == 0, "thread-snapshot-contract"); return f_new_handle(F_SNAPSHOT, NULL);
}

/** 给出完整固定父线程结构并验证调用方先声明长度。 */
static BOOL WINAPI f_Thread32First(HANDLE snapshot, LPTHREADENTRY32 entry) {
    f_require(f_handle(snapshot) != NULL && entry->dwSize == sizeof(*entry), "thread-entry-length");
    f_handle(snapshot)->enumeration_index = 1;
    entry->th32OwnerProcessID = 101; entry->th32ThreadID = 201; return TRUE;
}

/** 枚举结束只返回明确终止错误，不把未知失败冒充完整集合。 */
static BOOL WINAPI f_Thread32Next(HANDLE snapshot, LPTHREADENTRY32 entry) {
    FHandle *handle = f_handle(snapshot);
    if (handle != NULL && handle->enumeration_index++ < f_thread_count) {
        entry->th32OwnerProcessID = 101; entry->th32ThreadID = 202; return TRUE;
    }
    SetLastError(ERROR_NO_MORE_FILES); return FALSE;
}

/** 父创建时间是固定已持对象身份，不是外部编号存在检查。 */
static BOOL WINAPI f_GetProcessTimes(HANDLE value, LPFILETIME creation, LPFILETIME exited, LPFILETIME kernel, LPFILETIME user) {
    f_require(f_handle(value) != NULL, "process-time-held-handle");
    creation->dwLowDateTime = f_failure == F_PARENT_CREATION_CHANGED && f_impersonating ? 101 : 100; creation->dwHighDateTime = 1;
    memset(exited, 0, sizeof(*exited)); memset(kernel, 0, sizeof(*kernel)); memset(user, 0, sizeof(*user)); return TRUE;
}

/** 固定线程创建时间供新开句柄前后核对，不能由默认零值补查询。 */
static BOOL WINAPI f_GetThreadTimes(HANDLE value, LPFILETIME creation, LPFILETIME exited, LPFILETIME kernel, LPFILETIME user) {
    f_require(f_handle(value) != NULL, "thread-time-held-handle");
    creation->dwLowDateTime = f_failure == F_THREAD_CREATION_CHANGED && f_impersonating ? 201 : 200; creation->dwHighDateTime = 1;
    memset(exited, 0, sizeof(*exited)); memset(kernel, 0, sizeof(*kernel)); memset(user, 0, sizeof(*user)); return TRUE;
}

/** 固定标识只用于纯内存场景，从不作为现场进程操作目标。 */
static DWORD WINAPI f_GetCurrentProcessId(void) { return 101; }
/** 返回本场景唯一合成父线程标识。 */
static DWORD WINAPI f_GetCurrentThreadId(void) { return 201; }
/** 提供仅给映射OpenThreadToken使用的伪句柄。 */
static HANDLE WINAPI f_GetCurrentThread(void) { return (HANDLE)(ULONG_PTR)0xfffffff0; }

/** 固定保留特权必须精确按名称查询；失败不能继续过滤。 */
static BOOL WINAPI f_LookupPrivilegeValueW(LPCWSTR system, LPCWSTR name, PLUID luid) {
    f_require(system == NULL && wcscmp(name, L"SeChangeNotifyPrivilege") == 0, "exact-change-notify-lookup");
    if (f_failure == F_NOTIFY_LOOKUP) { SetLastError(ERROR_NO_SUCH_PRIVILEGE); return FALSE; }
    luid->LowPart = 23; luid->HighPart = 0; return TRUE;
}

/** 有界复制系统路径，模拟接口失败不从继承环境补值。 */
static UINT f_path_value(WCHAR *buffer, UINT count, const WCHAR *value) {
    size_t length = wcslen(value);
    if (length >= count) return (UINT)length + 1;
    memcpy(buffer, value, (length + 1) * sizeof(WCHAR)); return (UINT)length;
}

/** 允许名单环境的系统根来自固定只读系统接口。 */
static UINT WINAPI f_GetSystemWindowsDirectoryW(LPWSTR buffer, UINT count) {
    if (f_failure == F_ENVIRONMENT) { SetLastError(ERROR_ACCESS_DENIED); return 0; }
    return f_path_value(buffer, count, L"C:\\Windows");
}
/** 系统目录值与继承PATH无关。 */
static UINT WINAPI f_GetSystemDirectoryW(LPWSTR buffer, UINT count) { return f_path_value(buffer, count, L"C:\\Windows\\SysWOW64"); }
/** 32位模块路径只允许系统WOW64物理目录。 */
static UINT WINAPI f_GetSystemWow64DirectoryW(LPWSTR buffer, UINT count) { return f_path_value(buffer, count, L"C:\\Windows\\SysWOW64"); }
/** 已加载固定系统模块替身，不加载工作区库。 */
static HMODULE WINAPI f_GetModuleHandleW(LPCWSTR name) {
    f_require(wcscmp(name, L"kernel32.dll") == 0, "fixed-kernel-module"); return (HMODULE)(ULONG_PTR)0x777;
}
/** 主路径与系统模块分别绑定；负面路径不能作为可用导出来源。 */
static DWORD WINAPI f_GetModuleFileNameW(HMODULE module, LPWSTR buffer, DWORD count) {
    const WCHAR *value = module == NULL ? AWR_LAUNCHER_PATH : L"C:\\Windows\\SysWOW64\\kernel32.dll";
    if (f_failure == F_SELF_PATH && module == NULL) value = L"C:\\UserWritable\\other.exe";
    if (f_failure == F_MODULE_PATH && module != NULL) value = L"C:\\UserWritable\\kernel32.dll";
    return f_path_value(buffer, count, value);
}

/** 只接受属性长度探测的明确不足错误，错误长度和初始化失败均无回退。 */
static BOOL WINAPI f_initialize_attributes(void *storage, DWORD count, DWORD flags, SIZE_T *size) {
    f_require(count == 1 && flags == 0, "one-job-attribute-list");
    if (storage == NULL) {
        *size = f_failure == F_ATTRIBUTE_SIZE ? 1024UL * 1024UL + 1 : 64;
        if (f_failure == F_ATTRIBUTE_PROBE) { SetLastError(ERROR_INVALID_PARAMETER); return FALSE; }
        SetLastError(ERROR_INSUFFICIENT_BUFFER); return FALSE;
    }
    if (f_failure == F_ATTRIBUTE_INIT) { SetLastError(ERROR_NOT_SUPPORTED); return FALSE; }
    f_attribute_ready = TRUE; return TRUE;
}

/** 扩展属性必须是单一非继承job列表，保持到创建调用结束，不允许事后关联回退。 */
static BOOL WINAPI f_update_attribute(void *storage, DWORD flags, DWORD_PTR key, void *data,
    SIZE_T size, void *previous, SIZE_T *returned) {
    f_require(storage != NULL && f_attribute_ready && flags == 0 && key == F_JOB_ATTRIBUTE &&
        data != NULL && size == sizeof(HANDLE) && previous == NULL && returned == NULL, "creation-job-list-only");
    f_require(*(HANDLE *)data == f_job_handle, "job-list-unique-handle");
    if (f_failure == F_ATTRIBUTE_UPDATE) { SetLastError(ERROR_NOT_SUPPORTED); return FALSE; }
    f_attribute_job = TRUE; return TRUE;
}

/** 销毁已初始化属性一次，初始化失败时不得伪调用销毁。 */
static void WINAPI f_destroy_attributes(void *storage) {
    f_require(storage != NULL && f_attribute_ready, "delete-only-initialized-attributes");
    ++f_delete_attributes; f_attribute_ready = FALSE;
}

/** 查询本次实际子是否属于唯一job；失败或FALSE都不得恢复。 */
static BOOL WINAPI f_process_in_job(HANDLE process, HANDLE job, PBOOL contained) {
    f_require(process == f_child_handle && job == f_job_handle && !f_job_closed, "actual-created-child-in-unique-job");
    if (f_failure == F_CHILD_JOB_QUERY) { SetLastError(ERROR_ACCESS_DENIED); return FALSE; }
    *contained = f_failure != F_CHILD_NOT_JOB; return TRUE;
}

/** 固定导出表只提供映射协议接口，不使生产加载额外模块或拥有测试旁路。 */
static FARPROC WINAPI f_GetProcAddress(HMODULE module, LPCSTR name) {
    f_require(module == (HMODULE)(ULONG_PTR)0x777, "exports-from-verified-module");
    if (f_failure == F_EXPORT && strcmp(name, "UpdateProcThreadAttribute") == 0) return NULL;
    if (strcmp(name, "InitializeProcThreadAttributeList") == 0) return (FARPROC)(void *)f_initialize_attributes;
    if (strcmp(name, "UpdateProcThreadAttribute") == 0) return (FARPROC)(void *)f_update_attribute;
    if (strcmp(name, "DeleteProcThreadAttributeList") == 0) return (FARPROC)(void *)f_destroy_attributes;
    if (strcmp(name, "IsProcessInJob") == 0) return (FARPROC)(void *)f_process_in_job;
    f_require(FALSE, "unknown-export-request"); return NULL;
}

/** 创建纯内存匿名job，不接受继承安全属性或名字。 */
static HANDLE WINAPI f_CreateJobObjectW(LPSECURITY_ATTRIBUTES attributes, LPCWSTR name) {
    f_require(attributes == NULL && name == NULL, "anonymous-noninherited-job"); f_job_noninherited = TRUE;
    if (f_failure == F_JOB_CREATE) { SetLastError(ERROR_ACCESS_DENIED); return NULL; }
    f_job_handle = f_new_handle(F_JOB, NULL); return f_job_handle;
}

/** 唯一job必须在创建子前设置关闭杀死；无脱离或其它宽松标志。 */
static BOOL WINAPI f_SetInformationJobObject(HANDLE job, JOBOBJECTINFOCLASS kind, LPVOID data, DWORD size) {
    JOBOBJECT_EXTENDED_LIMIT_INFORMATION *limits = data;
    f_require(job == f_job_handle && kind == JobObjectExtendedLimitInformation && size == sizeof(*limits) &&
        limits->BasicLimitInformation.LimitFlags == JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE, "kill-on-close-before-child");
    if (f_failure == F_JOB_LIMIT) { SetLastError(ERROR_ACCESS_DENIED); return FALSE; }
    f_job_limit = TRUE; return TRUE;
}

/** 逐项读取生产生成环境，必须恰好排序的5个允许项，双零结束且不继承代码/代理注入变量。 */
static void f_check_environment(const WCHAR *environment) {
    const WCHAR *names[] = { L"PATH=", L"SystemRoot=", L"TEMP=", L"TMP=", L"WINDIR=" };
    const WCHAR *values[] = { L"C:\\Windows\\SysWOW64", L"C:\\Windows", AWR_TEMP_DIRECTORY, AWR_TEMP_DIRECTORY, L"C:\\Windows" };
    const WCHAR *cursor = environment;
    f_environment_entries = 0;
    for (DWORD i = 0; i < 5; ++i) {
        size_t prefix = wcslen(names[i]);
        f_require(wcsncmp(cursor, names[i], prefix) == 0 && wcscmp(cursor + prefix, values[i]) == 0,
            "allowlist-environment-values-and-order");
        ++f_environment_entries; cursor += wcslen(cursor) + 1;
    }
    f_require(*cursor == L'\0', "environment-double-null-no-inherited-entries");
    f_environment_clean = f_contract_errors == 0;
}

/** 仅验证创建协议，不创建真正子进程；全部父与主体门禁必须先完成，固定入口及完整参数不能覆盖。 */
static BOOL WINAPI f_CreateProcessAsUserW(HANDLE token, LPCWSTR application, LPWSTR command,
    LPSECURITY_ATTRIBUTES process_attributes, LPSECURITY_ATTRIBUTES thread_attributes, BOOL inherit,
    DWORD flags, LPVOID environment, LPCWSTR directory, LPSTARTUPINFOW startup, LPPROCESS_INFORMATION process) {
    FHandle *limited = f_handle(token);
    ++f_create_calls;
    f_require(limited != NULL && limited->token.type == TokenPrimary && !f_impersonating && f_revert_calls == 1,
        "all-subject-gates-before-create");
    f_require(wcscmp(application, AWR_NODE_PATH) == 0 && wcscmp(command, AWR_COMMAND_LINE) == 0 &&
        wcscmp(directory, AWR_PROJECT_ROOT) == 0, "fixed-application-command-and-directory");
    f_require(process_attributes == NULL && thread_attributes == NULL && !inherit &&
        flags == (CREATE_SUSPENDED | CREATE_NO_WINDOW | CREATE_UNICODE_ENVIRONMENT | F_EXTENDED_STARTUPINFO),
        "suspended-hidden-no-handle-inheritance-no-breakaway");
    f_require(startup->cb == sizeof(FStartup) && ((FStartup *)startup)->attributes != NULL &&
        f_job_noninherited && f_job_limit && f_attribute_ready && f_attribute_job && !f_job_closed,
        "job-list-at-creation-with-live-attribute-storage");
    f_check_environment(environment);
    if (f_failure == F_CREATE_CHILD) { SetLastError(ERROR_PRIVILEGE_NOT_HELD); return FALSE; }
    f_child_created = TRUE;
    memset(process, 0, sizeof(*process));
    process->hProcess = f_child_handle = f_new_handle(F_CHILD, NULL);
    process->hThread = f_new_handle(F_CHILD_THREAD, NULL); process->dwProcessId = 301; process->dwThreadId = 401;
    return TRUE;
}

/** 恢复只允许一次，且属性已清理、有限主体及父对象均已核验。 */
static DWORD WINAPI f_ResumeThread(HANDLE thread) {
    FHandle *handle = f_handle(thread);
    ++f_resume_calls;
    f_require(handle != NULL && handle->kind == F_CHILD_THREAD && f_delete_attributes == 1 && !f_job_closed,
        "resume-only-created-suspended-child");
    if (f_failure == F_RESUME) { SetLastError(ERROR_ACCESS_DENIED); return (DWORD)-1; }
    return f_failure == F_RESUME_COUNT ? 2 : 1;
}

/** 正常等待只对唯一创建的子对象；失败清理要先结束子并关闭job，再等待同一稳定句柄。 */
static DWORD WINAPI f_WaitForSingleObject(HANDLE process, DWORD milliseconds) {
    ++f_wait_calls;
    f_require(process == f_child_handle && milliseconds == INFINITE, "wait-unique-created-child-handle");
    if (f_child_terminated) { f_require(f_job_closed, "cleanup-closes-job-before-wait"); return WAIT_OBJECT_0; }
    f_waited_unique = TRUE;
    if (f_failure == F_WAIT) { SetLastError(ERROR_ACCESS_DENIED); return WAIT_FAILED; }
    return f_failure == F_WAIT_UNKNOWN ? WAIT_ABANDONED : WAIT_OBJECT_0;
}

/** 服务退出值保持全部32位，不截断或仅从健康状态推断成功。 */
static BOOL WINAPI f_GetExitCodeProcess(HANDLE process, PDWORD code) {
    f_require(process == f_child_handle && f_waited_unique, "exit-code-after-unique-child-wait");
    if (f_failure == F_EXIT_QUERY) { SetLastError(ERROR_ACCESS_DENIED); return FALSE; }
    *code = F_EXIT_CODE; return TRUE;
}

/** 所有失败仅终止本次已持子句柄；协议替身不操作任何现场编号或映像。 */
static BOOL WINAPI f_TerminateProcess(HANDLE process, UINT code) {
    (void)code;
    f_require(process == f_child_handle && f_child_created, "terminate-only-created-child-handle");
    ++f_terminate_calls; f_child_terminated = TRUE; return TRUE;
}

/* Windows头已完整先包含；映射只在此夹具编译单元生效，生产文件没有测试宏、条件分支或调用旁路。 */
#define HeapAlloc f_HeapAlloc
#define HeapReAlloc f_HeapReAlloc
#define HeapFree f_HeapFree
#define LocalFree f_LocalFree
#define CloseHandle f_CloseHandle
#define GetTokenInformation f_GetTokenInformation
#define CreateRestrictedToken f_CreateRestrictedToken
#define SetTokenInformation f_SetTokenInformation
#define DuplicateTokenEx f_DuplicateTokenEx
#define CheckTokenMembership f_CheckTokenMembership
#define GetSecurityInfo f_GetSecurityInfo
#define OpenProcess f_OpenProcess
#define OpenThread f_OpenThread
#define OpenProcessToken f_OpenProcessToken
#define OpenThreadToken f_OpenThreadToken
#define SetThreadToken f_SetThreadToken
#define RevertToSelf f_RevertToSelf
#define CreateToolhelp32Snapshot f_CreateToolhelp32Snapshot
#define Thread32First f_Thread32First
#define Thread32Next f_Thread32Next
#define GetProcessTimes f_GetProcessTimes
#define GetThreadTimes f_GetThreadTimes
#define GetCurrentProcessId f_GetCurrentProcessId
#define GetCurrentThreadId f_GetCurrentThreadId
#define GetCurrentThread f_GetCurrentThread
#define LookupPrivilegeValueW f_LookupPrivilegeValueW
#define GetSystemWindowsDirectoryW f_GetSystemWindowsDirectoryW
#define GetSystemDirectoryW f_GetSystemDirectoryW
#define GetSystemWow64DirectoryW f_GetSystemWow64DirectoryW
#define GetModuleHandleW f_GetModuleHandleW
#define GetModuleFileNameW f_GetModuleFileNameW
#define GetProcAddress f_GetProcAddress
#define CreateJobObjectW f_CreateJobObjectW
#define SetInformationJobObject f_SetInformationJobObject
#define CreateProcessAsUserW f_CreateProcessAsUserW
#define ResumeThread f_ResumeThread
#define WaitForSingleObject f_WaitForSingleObject
#define GetExitCodeProcess f_GetExitCodeProcess
#define TerminateProcess f_TerminateProcess
#define main production_entry_not_run
#include "../../ops/native/background-launcher.c"
#undef main
#undef LocalFree

/** 每次场景重置纯内存对象，所有前一场景清理断言由调用者先完成。 */
static void f_reset(enum FFailure failure, DWORD fail_right) {
    memset(f_handles, 0, sizeof(f_handles)); memset(f_allocations, 0, sizeof(f_allocations));
    memset(f_descriptors, 0, sizeof(f_descriptors)); memset(&f_original, 0, sizeof(f_original));
    memset(&f_limited, 0, sizeof(f_limited));
    f_failure = failure; f_fail_right = fail_right;
    f_allocation_attempts = f_duplicate_calls = f_last_reallocation_attempt = 0;
    f_fail_allocation = failure == F_HEAP_FAIL || failure == F_HEAP_FAIL_SECOND ? fail_right : 0;
    f_thread_count = failure == F_TWO_THREADS || failure == F_ACCESS_GRANTED_SECOND ||
        failure == F_ACCESS_UNKNOWN_SECOND || failure == F_HEAP_FAIL_SECOND ? 2 : 1;
    f_next_handle = f_active_handles = f_allocated = f_descriptor_count = f_contract_errors = 0;
    f_restricted_calls = f_create_calls = f_resume_calls = f_terminate_calls = f_wait_calls = 0;
    f_delete_attributes = f_revert_calls = f_right_index = f_process_rights = f_thread_rights = f_token_rights = 0;
    f_environment_entries = 0;
    f_impersonating = f_child_created = f_child_terminated = f_job_closed = FALSE;
    f_filtered_lists = f_job_noninherited = f_job_limit = f_environment_clean = FALSE;
    f_attribute_ready = f_attribute_job = f_waited_unique = FALSE;
    f_job_handle = f_child_handle = NULL;
    f_original.user = failure == F_PARENT_USER ? f_wrong_user : f_user;
    f_original.type = TokenPrimary; f_original.session = failure == F_PARENT_SESSION ? 1 : 0;
    f_original.integrity = failure == F_PARENT_LABEL ? SECURITY_MANDATORY_MEDIUM_RID : SECURITY_MANDATORY_HIGH_RID;
    f_original.token_id.LowPart = 11; f_original.authentication_id.LowPart = 77;
    f_original.group_count = f_sid_count + 1;
    /* 初始高完整性组必须由SetTokenInformation同步变为中等；标签字段与组字段各自验证，不能循环自证。 */
    f_original.groups[0] = f_high; f_original.attributes[0] = SE_GROUP_INTEGRITY | SE_GROUP_INTEGRITY_ENABLED;
    for (DWORD i = 0; i < f_sid_count; ++i) {
        f_original.groups[i + 1] = f_sids[i]; f_original.attributes[i + 1] = SE_GROUP_ENABLED | SE_GROUP_ENABLED_BY_DEFAULT | SE_GROUP_MANDATORY;
        if (i == f_sid_count - 4) f_original.attributes[i + 1] |= SE_GROUP_LOGON_ID;
    }
    f_original.privilege_count = 4;
    for (DWORD i = 0; i < 4; ++i) {
        f_original.privileges[i].Luid.LowPart = i == 0 ? 23 : 10 + i;
        f_original.privileges[i].Attributes = SE_PRIVILEGE_ENABLED;
    }
    f_original.privileges[3].Attributes = 0;
    SetLastError(ERROR_SUCCESS);
}

typedef struct { const char *name; enum FFailure failure; enum AwrStage stage; BOOL created; BOOL resumed; } FCase;

/** 运行唯一生产入口并核对阶段、门禁顺序、完整退出码及全部稳定句柄/缓冲清理。 */
static BOOL f_run_case(const FCase *item, DWORD fail_right) {
    DWORD result;
    BOOL valid;
    f_reset(item->failure, fail_right);
    result = awr_launch();
    valid = item->failure == F_OK || item->failure == F_TWO_THREADS ? result == F_EXIT_CODE :
        item->failure == F_HEAP_FAIL || item->failure == F_HEAP_FAIL_SECOND ?
        (result & 0xff000000UL) == 0xA7000000UL && (result & 0xffffUL) == ERROR_NOT_ENOUGH_MEMORY :
        (result & 0xffff0000UL) == (0xA7000000UL | ((DWORD)item->stage << 16));
    f_require(valid, "failure-stage-or-full-exit-code");
    if (item->failure == F_HEAP_FAIL || item->failure == F_HEAP_FAIL_SECOND) f_require(f_resume_calls == 0, "allocation-failure-never-resumes-child");
    else f_require(f_child_created == item->created && (f_resume_calls != 0) == item->resumed, "gate-created-and-resumed-observation");
    f_require(f_create_calls <= 1 && f_resume_calls <= 1 && f_delete_attributes <= 1, "no-creation-attribute-or-resume-retry");
    f_require(f_active_handles == 0 && f_allocated == 0 && f_descriptor_count == 0, "all-handle-token-and-buffer-cleanup");
    f_require(!f_attribute_ready, "all-initialized-attributes-cleaned");
    if (f_child_created && item->failure != F_OK && item->failure != F_TWO_THREADS) f_require(f_terminate_calls == 1 && f_job_closed && f_child_terminated, "created-child-failure-closes-tree");
    if (item->stage == AWR_STAGE_PARENT_ACCESS) f_require(f_revert_calls == (item->failure == F_DUPLICATE_ACCESS ? 0u : 1u) && f_create_calls == 0,
        "access-failure-reverts-only-after-attempted-impersonation-and-no-child");
    if (item->failure == F_OK || item->failure == F_TWO_THREADS) {
        f_require(f_filtered_lists && f_process_rights == 11 && f_thread_rights == 8 * f_thread_count && f_token_rights == 9,
            "complete-28-single-danger-rights");
        f_require(f_environment_clean && f_environment_entries == 5 && f_waited_unique && f_terminate_calls == 0,
            "normal-environment-wait-and-no-termination");
        f_require(f_original.integrity == SECURITY_MANDATORY_HIGH_RID && f_original.privilege_count == 4,
            "original-parent-token-unchanged");
    }
    if (item->failure != F_REVERT) f_require(!f_impersonating, "restored-original-thread-context");
    if (f_contract_errors != 0) fprintf(stderr, "protocol-case=%s right=%lu result=%lu errors=%lu\n", item->name,
        (unsigned long)fail_right, (unsigned long)result, (unsigned long)f_contract_errors);
    return f_contract_errors == 0;
}

/** 真安全标识符仅是夹具数据，固定人工主体与组，绝不读取现场账户或凭据。 */
static BOOL f_initialize_sids(void) {
    const WCHAR *texts[] = { L"S-1-1-0", L"S-1-2-0", L"S-1-2-1", L"S-1-5-11", L"S-1-5-3", L"S-1-5-4", L"S-1-5-6", L"S-1-5-113",
        L"S-1-5-32-545", L"S-1-5-5-123-456", L"S-1-5-32-544", L"S-1-5-32-547", L"S-1-5-21-999-888-777-555" };
    WCHAR text[256];
    memcpy(text, AWR_USER_SID, (wcslen(AWR_USER_SID) + 1) * sizeof(WCHAR));
    if (!ConvertStringSidToSidW(text, &f_user) || !ConvertStringSidToSidW(L"S-1-5-21-333-222-111-1001", &f_wrong_user) ||
        !ConvertStringSidToSidW(L"S-1-16-8192", &f_medium) || !ConvertStringSidToSidW(L"S-1-16-12288", &f_high)) return FALSE;
    f_sid_count = sizeof(texts) / sizeof(texts[0]);
    for (DWORD i = 0; i < f_sid_count; ++i) {
        wcscpy(text, texts[i]); if (!ConvertStringSidToSidW(text, &f_sids[i])) return FALSE;
    }
    return TRUE;
}

/** 有界入口逐场景测试成功、失败关闭及28位各自授予/未知错误，不运行生产main。 */
int main(void) {
    const FCase cases[] = {
        {"normal", F_OK, 0, TRUE, TRUE},
        {"normal-two-parent-threads", F_TWO_THREADS, 0, TRUE, TRUE},
        {"self-path", F_SELF_PATH, AWR_STAGE_SELF_PATH, FALSE, FALSE},
        {"existing-thread-token", F_EXISTING_IMPERSONATION, AWR_STAGE_PARENT, FALSE, FALSE},
        {"parent-user", F_PARENT_USER, AWR_STAGE_PARENT, FALSE, FALSE},
        {"parent-session", F_PARENT_SESSION, AWR_STAGE_PARENT, FALSE, FALSE},
        {"parent-label", F_PARENT_LABEL, AWR_STAGE_PARENT, FALSE, FALSE},
        {"descriptor-query", F_DESCRIPTOR_QUERY, AWR_STAGE_PARENT, FALSE, FALSE},
        {"descriptor-low", F_DESCRIPTOR_LOW, AWR_STAGE_PARENT, FALSE, FALSE},
        {"descriptor-no-dacl", F_DESCRIPTOR_NO_DACL, AWR_STAGE_PARENT, FALSE, FALSE},
        {"descriptor-no-label", F_DESCRIPTOR_NO_LABEL, AWR_STAGE_PARENT, FALSE, FALSE},
        {"notify-lookup", F_NOTIFY_LOOKUP, AWR_STAGE_CHANGE_NOTIFY, FALSE, FALSE},
        {"restricted-create", F_RESTRICTED_CREATE, AWR_STAGE_LIMITED_CREATE, FALSE, FALSE},
        {"set-medium-label", F_SET_LABEL, AWR_STAGE_LIMITED_CREATE, FALSE, FALSE},
        {"unknown-group-still-enabled", F_LIMITED_ENABLED_GROUP, AWR_STAGE_LIMITED_VERIFY, FALSE, FALSE},
        {"extra-privilege", F_LIMITED_EXTRA_PRIVILEGE, AWR_STAGE_LIMITED_VERIFY, FALSE, FALSE},
        {"effective-admin", F_LIMITED_ADMIN, AWR_STAGE_LIMITED_VERIFY, FALSE, FALSE},
        {"actual-thread-token-mismatch", F_THREAD_IDENTITY, AWR_STAGE_PARENT_ACCESS, FALSE, FALSE},
        {"set-thread-failed", F_SET_THREAD, AWR_STAGE_PARENT_ACCESS, FALSE, FALSE},
        {"revert-failed", F_REVERT, AWR_STAGE_PARENT_ACCESS, FALSE, FALSE},
        {"residual-thread-token", F_RESIDUAL_TOKEN, AWR_STAGE_PARENT_ACCESS, FALSE, FALSE},
        {"environment-query", F_ENVIRONMENT, AWR_STAGE_ENVIRONMENT, FALSE, FALSE},
        {"missing-fixed-export", F_EXPORT, AWR_STAGE_SYSTEM_EXPORTS, FALSE, FALSE},
        {"wrong-system-module-path", F_MODULE_PATH, AWR_STAGE_SYSTEM_EXPORTS, FALSE, FALSE},
        {"job-create", F_JOB_CREATE, AWR_STAGE_JOB_CREATE, FALSE, FALSE},
        {"job-limit", F_JOB_LIMIT, AWR_STAGE_JOB_LIMIT, FALSE, FALSE},
        {"attribute-probe", F_ATTRIBUTE_PROBE, AWR_STAGE_ATTRIBUTES, FALSE, FALSE},
        {"attribute-size", F_ATTRIBUTE_SIZE, AWR_STAGE_ATTRIBUTES, FALSE, FALSE},
        {"attribute-init", F_ATTRIBUTE_INIT, AWR_STAGE_ATTRIBUTES, FALSE, FALSE},
        {"attribute-update", F_ATTRIBUTE_UPDATE, AWR_STAGE_JOB_ATTRIBUTE, FALSE, FALSE},
        {"child-create", F_CREATE_CHILD, AWR_STAGE_CHILD_CREATE, FALSE, FALSE},
        {"child-not-in-job", F_CHILD_NOT_JOB, AWR_STAGE_CHILD_JOB, TRUE, FALSE},
        {"child-job-query", F_CHILD_JOB_QUERY, AWR_STAGE_CHILD_JOB, TRUE, FALSE},
        {"child-token-open", F_CHILD_TOKEN_OPEN, AWR_STAGE_CHILD_TOKEN, TRUE, FALSE},
        {"child-token-invalid", F_CHILD_BAD_TOKEN, AWR_STAGE_CHILD_VERIFY, TRUE, FALSE},
        {"child-authentication-mismatch", F_CHILD_IDENTITY, AWR_STAGE_CHILD_VERIFY, TRUE, FALSE},
        {"parent-contract-changed", F_PARENT_RECHECK, AWR_STAGE_PARENT_RECHECK, TRUE, FALSE},
        {"resume-failed", F_RESUME, AWR_STAGE_CHILD_RESUME, TRUE, TRUE},
        {"resume-wrong-suspend-count", F_RESUME_COUNT, AWR_STAGE_CHILD_RESUME, TRUE, TRUE},
        {"wait-failed", F_WAIT, AWR_STAGE_CHILD_WAIT, TRUE, TRUE},
        {"wait-unknown", F_WAIT_UNKNOWN, AWR_STAGE_CHILD_WAIT, TRUE, TRUE},
        {"exit-query", F_EXIT_QUERY, AWR_STAGE_CHILD_EXIT, TRUE, TRUE},
        {"invalid-query-probe-success", F_QUERY_PROBE, AWR_STAGE_PARENT, FALSE, FALSE},
        {"invalid-query-return-length", F_QUERY_LENGTH, AWR_STAGE_PARENT, FALSE, FALSE},
        {"sid-not-in-returned-buffer", F_QUERY_BUFFER_SID, AWR_STAGE_PARENT, FALSE, FALSE},
        {"parent-no-write-up-policy", F_PARENT_POLICY, AWR_STAGE_PARENT, FALSE, FALSE},
        {"limited-no-write-up-policy", F_LIMITED_POLICY, AWR_STAGE_LIMITED_VERIFY, FALSE, FALSE},
        {"duplicate-role-token-failed", F_DUPLICATE_ROLE, AWR_STAGE_LIMITED_VERIFY, FALSE, FALSE},
        {"actual-thread-group-attribute-mismatch", F_THREAD_GROUP_ATTRIBUTE, AWR_STAGE_PARENT_ACCESS, FALSE, FALSE},
        {"child-group-attribute-mismatch", F_CHILD_GROUP_ATTRIBUTE, AWR_STAGE_CHILD_VERIFY, TRUE, FALSE},
        {"child-privilege-attribute-mismatch", F_CHILD_PRIVILEGE_ATTRIBUTE, AWR_STAGE_CHILD_VERIFY, TRUE, FALSE},
        {"child-login-group-mismatch", F_CHILD_LOGON_GROUP, AWR_STAGE_CHILD_VERIFY, TRUE, FALSE},
        {"limited-integrity-group-remains-high", F_LIMITED_INTEGRITY_GROUP, AWR_STAGE_LIMITED_VERIFY, FALSE, FALSE},
        {"access-duplicate-failed-before-impersonation", F_DUPLICATE_ACCESS, AWR_STAGE_PARENT_ACCESS, FALSE, FALSE},
        {"fresh-parent-creation-time-changed", F_PARENT_CREATION_CHANGED, AWR_STAGE_PARENT_ACCESS, FALSE, FALSE},
        {"fresh-thread-creation-time-changed", F_THREAD_CREATION_CHANGED, AWR_STAGE_PARENT_ACCESS, FALSE, FALSE},
        {"fresh-parent-token-id-changed", F_PARENT_TOKEN_ID_CHANGED, AWR_STAGE_PARENT_ACCESS, FALSE, FALSE}
    };
    DWORD passed = 0, failed = 0, direct_assertions = 0, allocation_scenarios = 0, reallocation_scenario = 0;
    if (!f_initialize_sids()) { fprintf(stderr, "fixture-sid-initialize-error=%lu\n", (unsigned long)GetLastError()); return 1; }
    /* 精确允许名单与登录组标志直接断言，不借令牌过滤替身对允许规则循环自证。 */
    for (DWORD i = 0; i < f_sid_count; ++i) {
        BOOL expected = i < f_sid_count - 3;
        BOOL actual = sid_is_allowed(f_sids[i], i == f_sid_count - 4 ? SE_GROUP_LOGON_ID : 0, f_user);
        if (actual == expected) ++passed; else { ++failed; fprintf(stderr, "allowlist-index=%lu\n", (unsigned long)i); }
        ++direct_assertions;
    }
    if (sid_is_allowed(f_user, 0, f_user) && !sid_is_allowed(f_sids[f_sid_count - 4], 0, f_user)) ++passed; else ++failed;
    ++direct_assertions;
    for (DWORD i = 0; i < sizeof(cases) / sizeof(cases[0]); ++i) {
        if (f_run_case(&cases[i], 0)) ++passed; else ++failed;
        if (cases[i].failure == F_OK) allocation_scenarios = f_allocation_attempts;
        if (cases[i].failure == F_TWO_THREADS) reallocation_scenario = f_last_reallocation_attempt;
    }
    /* 第二真实父线程替身的8个危险权限位也逐项授予/未知错误，验证循环没有仅测首线程。 */
    for (DWORD i = 0; i < 8; ++i) {
        const FCase grant = { "second-thread-danger-bit-granted", F_ACCESS_GRANTED_SECOND, AWR_STAGE_PARENT_ACCESS, FALSE, FALSE };
        const FCase unknown = { "second-thread-danger-bit-unknown-error", F_ACCESS_UNKNOWN_SECOND, AWR_STAGE_PARENT_ACCESS, FALSE, FALSE };
        if (f_run_case(&grant, 19 + i)) ++passed; else ++failed;
        if (f_run_case(&unknown, 19 + i)) ++passed; else ++failed;
    }
    {
        const FCase failure = { "second-thread-reallocation-fails-closed", F_HEAP_FAIL_SECOND, 0, FALSE, FALSE };
        if (reallocation_scenario != 0 && f_run_case(&failure, reallocation_scenario)) ++passed; else ++failed;
    }
    /* 正常入口实际尝试的每个分配点分别失败；不预设数量，也不绕过生产清理路径。 */
    for (DWORD i = 1; i <= allocation_scenarios; ++i) {
        const FCase failure = { "each-allocation-fails-closed", F_HEAP_FAIL, 0, FALSE, FALSE };
        if (f_run_case(&failure, i)) ++passed; else ++failed;
    }
    for (DWORD i = 0; i < 28; ++i) {
        const FCase grant = { "single-danger-bit-granted", F_ACCESS_GRANTED, AWR_STAGE_PARENT_ACCESS, FALSE, FALSE };
        const FCase unknown = { "single-danger-bit-unknown-error", F_ACCESS_UNKNOWN_ERROR, AWR_STAGE_PARENT_ACCESS, FALSE, FALSE };
        if (f_run_case(&grant, i)) ++passed; else ++failed;
        if (f_run_case(&unknown, i)) ++passed; else ++failed;
    }
    for (DWORD i = 0; i < f_sid_count; ++i) LocalFree(f_sids[i]);
    LocalFree(f_user); LocalFree(f_wrong_user); LocalFree(f_medium); LocalFree(f_high);
    printf("{\"evidence\":\"fake-api-production-source-protocol-not-s4u\",\"passed\":%lu,\"failed\":%lu,"
        "\"entryScenarios\":%lu,\"directAllowlistAssertions\":%lu,\"singleDangerBits\":28,\"negativeAccessScenarios\":56,"
        "\"secondThreadDangerBits\":8,\"secondThreadNegativeScenarios\":16,\"allocationFailureScenarios\":%lu,\"reallocationFailureScenarios\":1,"
        "\"productionSourceIncluded\":true,\"productionTestSwitch\":false,\"realMutationApisInvoked\":false}\n",
        (unsigned long)passed, (unsigned long)failed, (unsigned long)(sizeof(cases) / sizeof(cases[0])),
        (unsigned long)direct_assertions, (unsigned long)allocation_scenarios);
    return failed == 0 ? 0 : 1;
}
