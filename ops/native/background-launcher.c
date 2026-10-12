/*
 * 本机固定绑定的受保护启动器。它不读取配置文件、不解释工作区代码，
 * 也不安装、修改或控制计划任务。父对象保护不成立时不得创建服务子进程。
 */
#ifndef _WIN32_WINNT
#define _WIN32_WINNT 0x0601
#endif
#define WIN32_LEAN_AND_MEAN
#include <windows.h>
#include <aclapi.h>
#include <sddl.h>
#include <tlhelp32.h>
#include <stddef.h>
#include <stdint.h>
#include <string.h>
#include <wchar.h>
#include "background-binding.h"

/* 现有32位 MinGW 头缺少这些 Windows 10 接口声明；数值来自系统接口。 */
#ifndef SYSTEM_MANDATORY_LABEL_ACE_TYPE
#define SYSTEM_MANDATORY_LABEL_ACE_TYPE 0x11
#endif
#ifndef SYSTEM_MANDATORY_LABEL_NO_WRITE_UP
#define SYSTEM_MANDATORY_LABEL_NO_WRITE_UP 0x1
#endif
#ifndef THREAD_QUERY_LIMITED_INFORMATION
#define THREAD_QUERY_LIMITED_INFORMATION 0x0800
#endif
#ifndef EXTENDED_STARTUPINFO_PRESENT
#define EXTENDED_STARTUPINFO_PRESENT 0x00080000
#endif
#ifndef PROC_THREAD_ATTRIBUTE_JOB_LIST
#define PROC_THREAD_ATTRIBUTE_JOB_LIST ((DWORD_PTR)0x0002000D)
#endif
#ifndef SID_MAX_SUB_AUTHORITIES
#define SID_MAX_SUB_AUTHORITIES 15
#endif
#ifndef TOKEN_ADJUST_SESSIONID
#define TOKEN_ADJUST_SESSIONID 0x0100
#endif

typedef struct AwrMandatoryLabelAce {
    ACE_HEADER Header;
    ACCESS_MASK Mask;
    DWORD SidStart;
} AwrMandatoryLabelAce;

typedef struct AwrStartupInfoEx {
    STARTUPINFOW StartupInfo;
    void *lpAttributeList;
} AwrStartupInfoEx;

typedef BOOL (WINAPI *AwrInitializeAttributes)(void *, DWORD, DWORD, SIZE_T *);
typedef BOOL (WINAPI *AwrUpdateAttribute)(void *, DWORD, DWORD_PTR, void *,
                                         SIZE_T, void *, SIZE_T *);
typedef void (WINAPI *AwrDeleteAttributes)(void *);
typedef BOOL (WINAPI *AwrIsProcessInJob)(HANDLE, HANDLE, PBOOL);

typedef struct AwrAttributeApis {
    AwrInitializeAttributes initialize;
    AwrUpdateAttribute update;
    AwrDeleteAttributes destroy;
    AwrIsProcessInJob is_process_in_job;
} AwrAttributeApis;

/* 此构建明确为32位，不能把旧头下的错误结构布局带入64位创建调用。 */
_Static_assert(sizeof(void *) == 4, "launcher build must be 32 bit");
_Static_assert(sizeof(STARTUPINFOW) == 68, "unexpected STARTUPINFOW layout");
_Static_assert(sizeof(AwrStartupInfoEx) == 72, "unexpected extended layout");
_Static_assert(offsetof(AwrStartupInfoEx, lpAttributeList) == 68,
               "unexpected attribute pointer offset");

typedef struct AwrTokenView {
    void *user_data;
    void *groups_data;
    void *privileges_data;
    void *label_data;
    void *restricted_data;
    DWORD user_size;
    DWORD groups_size;
    DWORD privileges_size;
    DWORD label_size;
    DWORD restricted_size;
    TOKEN_USER *user;
    TOKEN_GROUPS *groups;
    TOKEN_PRIVILEGES *privileges;
    TOKEN_MANDATORY_LABEL *label;
    TOKEN_GROUPS *restricted;
    TOKEN_TYPE type;
    DWORD session;
    TOKEN_STATISTICS statistics;
    TOKEN_MANDATORY_POLICY policy;
    SECURITY_IMPERSONATION_LEVEL impersonation_level;
} AwrTokenView;

typedef struct AwrThreadIdentity {
    DWORD id;
    HANDLE handle;
    FILETIME creation;
} AwrThreadIdentity;

typedef struct AwrParentState {
    DWORD id;
    HANDLE process;
    HANDLE token;
    FILETIME creation;
    LUID token_id;
    AwrThreadIdentity *threads;
    DWORD thread_count;
} AwrParentState;

enum AwrStage {
    AWR_STAGE_ARGUMENTS = 1,
    AWR_STAGE_BINDING = 2,
    AWR_STAGE_SELF_PATH = 3,
    AWR_STAGE_PARENT = 4,
    AWR_STAGE_CHANGE_NOTIFY = 5,
    AWR_STAGE_LIMITED_CREATE = 6,
    AWR_STAGE_LIMITED_VERIFY = 7,
    AWR_STAGE_PARENT_ACCESS = 8,
    AWR_STAGE_ENVIRONMENT = 9,
    AWR_STAGE_SYSTEM_EXPORTS = 10,
    AWR_STAGE_JOB_CREATE = 11,
    AWR_STAGE_JOB_LIMIT = 12,
    AWR_STAGE_ATTRIBUTES = 13,
    AWR_STAGE_JOB_ATTRIBUTE = 14,
    AWR_STAGE_CHILD_CREATE = 15,
    AWR_STAGE_CHILD_JOB = 16,
    AWR_STAGE_CHILD_TOKEN = 17,
    AWR_STAGE_CHILD_VERIFY = 18,
    AWR_STAGE_PARENT_RECHECK = 19,
    AWR_STAGE_CHILD_RESUME = 20,
    AWR_STAGE_CHILD_WAIT = 21,
    AWR_STAGE_CHILD_EXIT = 22
};

/* 仅编码固定阶段及系统错误，不把路径、身份或继承环境写到用户目录。 */
static DWORD encode_failure(enum AwrStage stage, DWORD error)
{
    if (error == ERROR_SUCCESS) error = ERROR_INVALID_DATA;
    return 0xA7000000UL | ((DWORD)stage << 16) | (error & 0xffffUL);
}

/* 将契约不符与接口查询失败统一作为关闭路径，并保留可读系统错误。 */
static BOOL invalid_data(void)
{
    SetLastError(ERROR_INVALID_DATA);
    return FALSE;
}

/* 比较稳定令牌标识和登录标识，不把编号或指针相同当作身份相同。 */
static BOOL luid_equal(const LUID *left, const LUID *right)
{
    return left->LowPart == right->LowPart && left->HighPart == right->HighPart;
}

/* 在调用安全标识符接口前，先验证它完整处于系统返回的有界缓冲区内。 */
static BOOL sid_in_buffer(const void *buffer, DWORD length, PSID sid)
{
    uintptr_t start = (uintptr_t)buffer;
    uintptr_t pointer = (uintptr_t)sid;
    DWORD offset;
    BYTE count;
    if (pointer < start || pointer - start > length) return FALSE;
    offset = (DWORD)(pointer - start);
    if (length - offset < 8) return FALSE;
    count = ((const SID *)sid)->SubAuthorityCount;
    if (count > SID_MAX_SUB_AUTHORITIES ||
        GetSidLengthRequired(count) > length - offset) return FALSE;
    return IsValidSid(sid);
}

/* 读取一次令牌信息；只接受确定的长度探测失败，拒绝未知返回与超大缓冲。 */
static BOOL query_token_information(HANDLE token, TOKEN_INFORMATION_CLASS kind,
                                    void **output, DWORD *length)
{
    DWORD required = 0;
    DWORD actual = 0;
    DWORD error;
    void *buffer;
    BOOL probe;
    *output = NULL;
    *length = 0;
    probe = GetTokenInformation(token, kind, NULL, 0, &required);
    error = GetLastError();
    if (!probe && error != ERROR_INSUFFICIENT_BUFFER) {
        SetLastError(error == ERROR_SUCCESS ? ERROR_INVALID_DATA : error);
        return FALSE;
    }
    if (probe || required == 0 || required > 1024UL * 1024UL)
        return invalid_data();
    buffer = HeapAlloc(GetProcessHeap(), HEAP_ZERO_MEMORY, required);
    if (buffer == NULL) {
        SetLastError(ERROR_NOT_ENOUGH_MEMORY);
        return FALSE;
    }
    if (!GetTokenInformation(token, kind, buffer, required, &actual)) {
        error = GetLastError();
        HeapFree(GetProcessHeap(), 0, buffer);
        SetLastError(error);
        return FALSE;
    }
    if (actual == 0 || actual > required) {
        HeapFree(GetProcessHeap(), 0, buffer);
        return invalid_data();
    }
    *output = buffer;
    *length = actual;
    return TRUE;
}

/* 固定大小的令牌字段必须完整返回，不能用未初始化的默认值补查询失败。 */
static BOOL query_fixed_token_information(HANDLE token,
                                          TOKEN_INFORMATION_CLASS kind,
                                          void *output, DWORD length)
{
    DWORD actual = 0;
    if (!GetTokenInformation(token, kind, output, length, &actual)) return FALSE;
    if (actual != length) return invalid_data();
    return TRUE;
}

/* 释放只读令牌快照；快照中的安全标识符由所属缓冲区统一持有。 */
static void free_token_view(AwrTokenView *view)
{
    HANDLE heap = GetProcessHeap();
    if (view->user_data != NULL) HeapFree(heap, 0, view->user_data);
    if (view->groups_data != NULL) HeapFree(heap, 0, view->groups_data);
    if (view->privileges_data != NULL) HeapFree(heap, 0, view->privileges_data);
    if (view->label_data != NULL) HeapFree(heap, 0, view->label_data);
    if (view->restricted_data != NULL) HeapFree(heap, 0, view->restricted_data);
    ZeroMemory(view, sizeof(*view));
}

/* 检查组数组的长度与各安全标识符，拒绝截断或越界的令牌快照。 */
static BOOL group_buffer_valid(TOKEN_GROUPS *groups, DWORD length)
{
    DWORD i;
    size_t offset = offsetof(TOKEN_GROUPS, Groups);
    if (length < offset ||
        groups->GroupCount > (length - offset) / sizeof(SID_AND_ATTRIBUTES))
        return FALSE;
    for (i = 0; i < groups->GroupCount; ++i) {
        if (!sid_in_buffer(groups, length, groups->Groups[i].Sid)) return FALSE;
    }
    return TRUE;
}

/* 从实际句柄读取主体、会话、完整性、登录标识、组和特权的完整快照。 */
static BOOL read_token_view(HANDLE token, AwrTokenView *view)
{
    DWORD error;
    ZeroMemory(view, sizeof(*view));
    if (!query_token_information(token, TokenUser, &view->user_data,
                                 &view->user_size) ||
        !query_token_information(token, TokenGroups, &view->groups_data,
                                 &view->groups_size) ||
        !query_token_information(token, TokenPrivileges, &view->privileges_data,
                                 &view->privileges_size) ||
        !query_token_information(token, TokenIntegrityLevel, &view->label_data,
                                 &view->label_size) ||
        !query_token_information(token, TokenRestrictedSids,
                                 &view->restricted_data, &view->restricted_size) ||
        !query_fixed_token_information(token, TokenType, &view->type,
                                       sizeof(view->type)) ||
        !query_fixed_token_information(token, TokenSessionId, &view->session,
                                       sizeof(view->session)) ||
        !query_fixed_token_information(token, TokenStatistics, &view->statistics,
                                       sizeof(view->statistics)) ||
        !query_fixed_token_information(token, TokenMandatoryPolicy, &view->policy,
                                       sizeof(view->policy))) goto failure;
    view->user = (TOKEN_USER *)view->user_data;
    view->groups = (TOKEN_GROUPS *)view->groups_data;
    view->privileges = (TOKEN_PRIVILEGES *)view->privileges_data;
    view->label = (TOKEN_MANDATORY_LABEL *)view->label_data;
    view->restricted = (TOKEN_GROUPS *)view->restricted_data;
    if (view->user_size < sizeof(TOKEN_USER) ||
        !sid_in_buffer(view->user_data, view->user_size, view->user->User.Sid) ||
        view->label_size < sizeof(TOKEN_MANDATORY_LABEL) ||
        !sid_in_buffer(view->label_data, view->label_size, view->label->Label.Sid) ||
        !group_buffer_valid(view->groups, view->groups_size) ||
        !group_buffer_valid(view->restricted, view->restricted_size) ||
        view->privileges_size < offsetof(TOKEN_PRIVILEGES, Privileges) ||
        view->privileges->PrivilegeCount >
            (view->privileges_size - offsetof(TOKEN_PRIVILEGES, Privileges)) /
                sizeof(LUID_AND_ATTRIBUTES) ||
        view->statistics.TokenType != view->type ||
        (view->type != TokenPrimary && view->type != TokenImpersonation)) {
        invalid_data();
        goto failure;
    }
    if (view->type == TokenImpersonation &&
        !query_fixed_token_information(token, TokenImpersonationLevel,
                                       &view->impersonation_level,
                                       sizeof(view->impersonation_level)))
        goto failure;
    return TRUE;
failure:
    error = GetLastError();
    free_token_view(view);
    SetLastError(error);
    return FALSE;
}

/* 只接受指定完整性标识符，不把任意最后一个子权限值当作完整性。 */
static BOOL integrity_sid_matches(PSID sid, DWORD level)
{
    static const SID_IDENTIFIER_AUTHORITY mandatory =
        { SECURITY_MANDATORY_LABEL_AUTHORITY };
    return IsValidSid(sid) && *GetSidSubAuthorityCount(sid) == 1 &&
           memcmp(GetSidIdentifierAuthority(sid), &mandatory,
                  sizeof(mandatory)) == 0 &&
           *GetSidSubAuthority(sid, 0) == level;
}

/* 精确组允许名单；登录组还必须具有内核登录组标志，不能仅匹配字符串。 */
static BOOL sid_is_allowed(PSID sid, DWORD attributes, PSID user_sid)
{
    const SID_IDENTIFIER_AUTHORITY *authority;
    BYTE count;
    DWORD first;
    static const SID_IDENTIFIER_AUTHORITY world = { SECURITY_WORLD_SID_AUTHORITY };
    static const SID_IDENTIFIER_AUTHORITY local = { SECURITY_LOCAL_SID_AUTHORITY };
    static const SID_IDENTIFIER_AUTHORITY nt = { SECURITY_NT_AUTHORITY };
    if (!IsValidSid(sid)) return FALSE;
    if (EqualSid(sid, user_sid)) return TRUE;
    authority = GetSidIdentifierAuthority(sid);
    count = *GetSidSubAuthorityCount(sid);
    if (count == 0) return FALSE;
    first = *GetSidSubAuthority(sid, 0);
    if (memcmp(authority, &world, sizeof(world)) == 0)
        return count == 1 && first == 0;
    if (memcmp(authority, &local, sizeof(local)) == 0)
        return count == 1 && (first == 0 || first == 1);
    if (memcmp(authority, &nt, sizeof(nt)) != 0) return FALSE;
    if (count == 1)
        return first == 11 || first == 3 || first == 4 || first == 6 ||
               first == 113;
    if (count == 2)
        return first == 32 && *GetSidSubAuthority(sid, 1) == 545;
    return count == 3 && first == 5 &&
           (attributes & SE_GROUP_LOGON_ID) == SE_GROUP_LOGON_ID;
}

/* 初始父主令牌必须是编译绑定原用户、会话0及已有高完整性；不修改它。 */
static BOOL verify_parent_token(HANDLE token, PSID user_sid)
{
    AwrTokenView view;
    BOOL valid;
    if (!read_token_view(token, &view)) return FALSE;
    valid = view.type == TokenPrimary && view.session == 0 &&
            EqualSid(view.user->User.Sid, user_sid) &&
            (view.label->Label.Attributes & SE_GROUP_INTEGRITY) != 0 &&
            integrity_sid_matches(view.label->Label.Sid,
                                  SECURITY_MANDATORY_HIGH_RID) &&
            (view.policy.Policy & TOKEN_MANDATORY_POLICY_NO_WRITE_UP) != 0 &&
            (view.policy.Policy & ~TOKEN_MANDATORY_POLICY_VALID_MASK) == 0;
    free_token_view(&view);
    return valid ? TRUE : invalid_data();
}

/* 管理员角色检查明确使用模拟令牌；不把主令牌直接传给成员检查接口。 */
static BOOL token_is_non_admin(HANDLE token, TOKEN_TYPE type)
{
    SID_IDENTIFIER_AUTHORITY nt = { SECURITY_NT_AUTHORITY };
    PSID administrators = NULL;
    HANDLE query_token = NULL;
    BOOL member = TRUE;
    BOOL valid = FALSE;
    DWORD error = ERROR_INVALID_DATA;
    if (!AllocateAndInitializeSid(&nt, 2, SECURITY_BUILTIN_DOMAIN_RID,
                                  DOMAIN_ALIAS_RID_ADMINS, 0, 0, 0, 0, 0, 0,
                                  &administrators)) return FALSE;
    if (type == TokenPrimary) {
        if (!DuplicateTokenEx(token, TOKEN_QUERY | TOKEN_IMPERSONATE, NULL,
                              SecurityImpersonation, TokenImpersonation,
                              &query_token)) {
            error = GetLastError();
            goto cleanup;
        }
    } else {
        query_token = token;
    }
    if (!CheckTokenMembership(query_token, administrators, &member)) {
        error = GetLastError();
        goto cleanup;
    }
    valid = !member;
cleanup:
    if (query_token != NULL && query_token != token) CloseHandle(query_token);
    FreeSid(administrators);
    if (!valid) SetLastError(error);
    return valid;
}

/* 唯一有限主体契约：中等完整性、原用户/会话、只有允许组与唯一可留特权。 */
static BOOL verify_limited_token(HANDLE token, PSID user_sid,
                                 const LUID *change_notify, TOKEN_TYPE type)
{
    AwrTokenView view;
    DWORD i;
    BOOL valid = FALSE;
    DWORD error = ERROR_INVALID_DATA;
    if (!read_token_view(token, &view)) return FALSE;
    if (view.type != type || view.session != 0 ||
        !EqualSid(view.user->User.Sid, user_sid) ||
        (view.label->Label.Attributes & SE_GROUP_INTEGRITY) == 0 ||
        !integrity_sid_matches(view.label->Label.Sid,
                               SECURITY_MANDATORY_MEDIUM_RID) ||
        (view.policy.Policy & TOKEN_MANDATORY_POLICY_NO_WRITE_UP) == 0 ||
        (view.policy.Policy & ~TOKEN_MANDATORY_POLICY_VALID_MASK) != 0 ||
        view.privileges->PrivilegeCount > 1 ||
        (type == TokenImpersonation &&
         view.impersonation_level != SecurityImpersonation)) goto cleanup;
    for (i = 0; i < view.groups->GroupCount; ++i) {
        SID_AND_ATTRIBUTES *group = &view.groups->Groups[i];
        if ((group->Attributes & SE_GROUP_INTEGRITY) != 0) {
            if (!integrity_sid_matches(group->Sid, SECURITY_MANDATORY_MEDIUM_RID))
                goto cleanup;
            continue;
        }
        if (!sid_is_allowed(group->Sid, group->Attributes, user_sid) &&
            (((group->Attributes & SE_GROUP_USE_FOR_DENY_ONLY) == 0) ||
             (group->Attributes & SE_GROUP_ENABLED) != 0)) goto cleanup;
    }
    for (i = 0; i < view.privileges->PrivilegeCount; ++i) {
        if (!luid_equal(&view.privileges->Privileges[i].Luid, change_notify))
            goto cleanup;
    }
    if (!token_is_non_admin(token, type)) {
        error = GetLastError();
        goto cleanup;
    }
    valid = TRUE;
cleanup:
    free_token_view(&view);
    if (!valid) SetLastError(error);
    return valid;
}

/* 用显式删除列表创建新主令牌；Flags=0，不改变原主令牌或依赖禁用特权。 */
static BOOL create_limited_token(HANDLE original, PSID user_sid,
                                 const LUID *change_notify, HANDLE *limited)
{
    AwrTokenView view;
    SID_AND_ATTRIBUTES *deny_groups = NULL;
    LUID_AND_ATTRIBUTES *remove_privileges = NULL;
    PSID medium_sid = NULL;
    SID_IDENTIFIER_AUTHORITY mandatory = { SECURITY_MANDATORY_LABEL_AUTHORITY };
    TOKEN_MANDATORY_LABEL label;
    DWORD deny_count = 0;
    DWORD remove_count = 0;
    DWORD i;
    DWORD error = ERROR_INVALID_DATA;
    BOOL valid = FALSE;
    *limited = NULL;
    if (!read_token_view(original, &view)) return FALSE;
    if (view.groups->GroupCount != 0) {
        deny_groups = HeapAlloc(GetProcessHeap(), HEAP_ZERO_MEMORY,
                                view.groups->GroupCount * sizeof(*deny_groups));
        if (deny_groups == NULL) { error = ERROR_NOT_ENOUGH_MEMORY; goto cleanup; }
    }
    if (view.privileges->PrivilegeCount != 0) {
        remove_privileges = HeapAlloc(GetProcessHeap(), HEAP_ZERO_MEMORY,
            view.privileges->PrivilegeCount * sizeof(*remove_privileges));
        if (remove_privileges == NULL) {
            error = ERROR_NOT_ENOUGH_MEMORY;
            goto cleanup;
        }
    }
    for (i = 0; i < view.groups->GroupCount; ++i) {
        SID_AND_ATTRIBUTES *group = &view.groups->Groups[i];
        if ((group->Attributes & SE_GROUP_INTEGRITY) == 0 &&
            !sid_is_allowed(group->Sid, group->Attributes, user_sid)) {
            deny_groups[deny_count++].Sid = group->Sid;
        }
    }
    for (i = 0; i < view.privileges->PrivilegeCount; ++i) {
        if (!luid_equal(&view.privileges->Privileges[i].Luid, change_notify)) {
            remove_privileges[remove_count++].Luid =
                view.privileges->Privileges[i].Luid;
        }
    }
    if (!CreateRestrictedToken(original, 0, deny_count, deny_groups,
                                remove_count, remove_privileges, 0, NULL,
                                limited)) {
        error = GetLastError();
        goto cleanup;
    }
    if (!AllocateAndInitializeSid(&mandatory, 1, SECURITY_MANDATORY_MEDIUM_RID,
                                  0, 0, 0, 0, 0, 0, 0, &medium_sid)) {
        error = GetLastError();
        goto cleanup;
    }
    ZeroMemory(&label, sizeof(label));
    label.Label.Sid = medium_sid;
    label.Label.Attributes = SE_GROUP_INTEGRITY;
    if (!SetTokenInformation(*limited, TokenIntegrityLevel, &label,
                              sizeof(label) + GetLengthSid(medium_sid))) {
        error = GetLastError();
        goto cleanup;
    }
    valid = TRUE;
cleanup:
    if (medium_sid != NULL) FreeSid(medium_sid);
    if (deny_groups != NULL) HeapFree(GetProcessHeap(), 0, deny_groups);
    if (remove_privileges != NULL) HeapFree(GetProcessHeap(), 0, remove_privileges);
    free_token_view(&view);
    if (!valid) {
        if (*limited != NULL) CloseHandle(*limited);
        *limited = NULL;
        SetLastError(error);
    }
    return valid;
}

/* 只读核验实际内核对象的所有者、自主访问控制及已有高标签；绝不补写权限。 */
static BOOL verify_object_label(HANDLE object)
{
    PSECURITY_DESCRIPTOR descriptor = NULL;
    PSID owner = NULL;
    PACL dacl = NULL;
    PACL sacl = NULL;
    SECURITY_DESCRIPTOR_CONTROL control = 0;
    DWORD revision = 0;
    DWORD labels = 0;
    DWORD i;
    DWORD error;
    BOOL valid = FALSE;
    error = GetSecurityInfo(object, SE_KERNEL_OBJECT,
        OWNER_SECURITY_INFORMATION | DACL_SECURITY_INFORMATION |
            LABEL_SECURITY_INFORMATION,
        &owner, NULL, &dacl, &sacl, &descriptor);
    if (error != ERROR_SUCCESS) { SetLastError(error); return FALSE; }
    error = ERROR_INVALID_DATA;
    if (descriptor == NULL || !IsValidSecurityDescriptor(descriptor) ||
        owner == NULL || !IsValidSid(owner) || dacl == NULL ||
        !IsValidAcl(dacl) || sacl == NULL || !IsValidAcl(sacl)) goto cleanup;
    if (!GetSecurityDescriptorControl(descriptor, &control, &revision)) {
        error = GetLastError();
        goto cleanup;
    }
    if ((control & SE_DACL_PRESENT) == 0 || (control & SE_SACL_PRESENT) == 0)
        goto cleanup;
    for (i = 0; i < sacl->AceCount; ++i) {
        ACE_HEADER *header = NULL;
        AwrMandatoryLabelAce *ace;
        if (!GetAce(sacl, i, (void **)&header)) {
            error = GetLastError();
            goto cleanup;
        }
        if (header->AceType != SYSTEM_MANDATORY_LABEL_ACE_TYPE) continue;
        ace = (AwrMandatoryLabelAce *)header;
        if ((header->AceFlags & INHERIT_ONLY_ACE) != 0 ||
            header->AceSize < offsetof(AwrMandatoryLabelAce, SidStart) + 8 ||
            !sid_in_buffer(ace, header->AceSize, &ace->SidStart) ||
            !integrity_sid_matches(&ace->SidStart, SECURITY_MANDATORY_HIGH_RID) ||
            (ace->Mask & SYSTEM_MANDATORY_LABEL_NO_WRITE_UP) == 0) goto cleanup;
        ++labels;
    }
    valid = labels == 1;
cleanup:
    if (descriptor != NULL) LocalFree(descriptor);
    if (!valid) SetLastError(error);
    return valid;
}

/* 保存创建时间用于真正新开的句柄核对；已持有的对象不会被编号替代。 */
static BOOL process_creation(HANDLE process, FILETIME *creation)
{
    FILETIME exit_time, kernel, user;
    return GetProcessTimes(process, creation, &exit_time, &kernel, &user);
}

/* 读取真实线程对象创建时间，失败不推断目标仍然有效。 */
static BOOL thread_creation(HANDLE thread, FILETIME *creation)
{
    FILETIME exit_time, kernel, user;
    return GetThreadTimes(thread, creation, &exit_time, &kernel, &user);
}

/* 检查父线程编号集合保持不变；新线程或枚举不完整都要求关闭启动路径。 */
static BOOL parent_threads_unchanged(const AwrParentState *parent)
{
    HANDLE snapshot;
    THREADENTRY32 entry;
    DWORD matched = 0;
    DWORD i;
    DWORD error = ERROR_INVALID_DATA;
    BOOL valid = FALSE;
    snapshot = CreateToolhelp32Snapshot(TH32CS_SNAPTHREAD, 0);
    if (snapshot == INVALID_HANDLE_VALUE) return FALSE;
    ZeroMemory(&entry, sizeof(entry));
    entry.dwSize = sizeof(entry);
    if (!Thread32First(snapshot, &entry)) { error = GetLastError(); goto cleanup; }
    do {
        if (entry.dwSize < offsetof(THREADENTRY32, th32OwnerProcessID) +
                               sizeof(entry.th32OwnerProcessID)) goto cleanup;
        if (entry.th32OwnerProcessID == parent->id) {
            for (i = 0; i < parent->thread_count; ++i)
                if (parent->threads[i].id == entry.th32ThreadID) break;
            if (i == parent->thread_count) goto cleanup;
            ++matched;
        }
        entry.dwSize = sizeof(entry);
    } while (Thread32Next(snapshot, &entry));
    error = GetLastError();
    if (error != ERROR_NO_MORE_FILES) goto cleanup;
    error = ERROR_INVALID_DATA;
    valid = matched == parent->thread_count && matched != 0;
cleanup:
    CloseHandle(snapshot);
    if (!valid) SetLastError(error);
    return valid;
}

/* 收集并持有父全部线程的稳定只读句柄，逐个核验系统创建的初始对象标签。 */
static BOOL capture_parent_threads(AwrParentState *parent)
{
    HANDLE snapshot;
    THREADENTRY32 entry;
    DWORD error = ERROR_INVALID_DATA;
    BOOL current_found = FALSE;
    BOOL valid = FALSE;
    snapshot = CreateToolhelp32Snapshot(TH32CS_SNAPTHREAD, 0);
    if (snapshot == INVALID_HANDLE_VALUE) return FALSE;
    ZeroMemory(&entry, sizeof(entry));
    entry.dwSize = sizeof(entry);
    if (!Thread32First(snapshot, &entry)) { error = GetLastError(); goto cleanup; }
    do {
        if (entry.dwSize < offsetof(THREADENTRY32, th32OwnerProcessID) +
                               sizeof(entry.th32OwnerProcessID)) goto cleanup;
        if (entry.th32OwnerProcessID == parent->id) {
            AwrThreadIdentity *next;
            AwrThreadIdentity *thread;
            SIZE_T bytes;
            if (parent->thread_count >= 1024) goto cleanup;
            bytes = (parent->thread_count + 1) * sizeof(*parent->threads);
            next = parent->threads == NULL ?
                HeapAlloc(GetProcessHeap(), HEAP_ZERO_MEMORY, bytes) :
                HeapReAlloc(GetProcessHeap(), HEAP_ZERO_MEMORY,
                            parent->threads, bytes);
            if (next == NULL) { error = ERROR_NOT_ENOUGH_MEMORY; goto cleanup; }
            parent->threads = next;
            thread = &parent->threads[parent->thread_count++];
            thread->id = entry.th32ThreadID;
            thread->handle = OpenThread(READ_CONTROL | THREAD_QUERY_LIMITED_INFORMATION,
                                         FALSE, thread->id);
            if (thread->handle == NULL ||
                !thread_creation(thread->handle, &thread->creation) ||
                !verify_object_label(thread->handle)) {
                error = GetLastError();
                goto cleanup;
            }
            if (thread->id == GetCurrentThreadId()) current_found = TRUE;
        }
        entry.dwSize = sizeof(entry);
    } while (Thread32Next(snapshot, &entry));
    error = GetLastError();
    if (error != ERROR_NO_MORE_FILES) goto cleanup;
    error = ERROR_INVALID_DATA;
    valid = parent->thread_count != 0 && current_found;
cleanup:
    CloseHandle(snapshot);
    if (!valid) SetLastError(error);
    return valid;
}

/* 释放本次父对象的查询句柄，不修改它们的描述符、令牌或线程状态。 */
static void free_parent_state(AwrParentState *parent)
{
    DWORD i;
    for (i = 0; i < parent->thread_count; ++i)
        if (parent->threads[i].handle != NULL) CloseHandle(parent->threads[i].handle);
    if (parent->threads != NULL) HeapFree(GetProcessHeap(), 0, parent->threads);
    if (parent->token != NULL) CloseHandle(parent->token);
    if (parent->process != NULL) CloseHandle(parent->process);
    ZeroMemory(parent, sizeof(*parent));
}

/* 建立初始父证据；已有线程模拟上下文一律拒绝，以便确定恢复目标为原始无模拟。 */
static BOOL check_parent_objects(AwrParentState *parent, PSID user_sid)
{
    HANDLE existing_thread_token = NULL;
    TOKEN_STATISTICS statistics;
    DWORD error;
    ZeroMemory(parent, sizeof(*parent));
    if (OpenThreadToken(GetCurrentThread(), TOKEN_QUERY, TRUE,
                        &existing_thread_token)) {
        CloseHandle(existing_thread_token);
        SetLastError(ERROR_BAD_IMPERSONATION_LEVEL);
        return FALSE;
    }
    if (GetLastError() != ERROR_NO_TOKEN) return FALSE;
    parent->id = GetCurrentProcessId();
    parent->process = OpenProcess(READ_CONTROL | PROCESS_QUERY_LIMITED_INFORMATION,
                                  FALSE, parent->id);
    if (parent->process == NULL ||
        !process_creation(parent->process, &parent->creation) ||
        !OpenProcessToken(parent->process,
            TOKEN_QUERY | TOKEN_DUPLICATE | TOKEN_ASSIGN_PRIMARY |
                TOKEN_ADJUST_DEFAULT | READ_CONTROL, &parent->token) ||
        !verify_parent_token(parent->token, user_sid) ||
        !query_fixed_token_information(parent->token, TokenStatistics,
                                       &statistics, sizeof(statistics)) ||
        !verify_object_label(parent->process) ||
        !verify_object_label(parent->token) ||
        !capture_parent_threads(parent) || !parent_threads_unchanged(parent)) {
        error = GetLastError();
        free_parent_state(parent);
        SetLastError(error);
        return FALSE;
    }
    parent->token_id = statistics.TokenId;
    return TRUE;
}

/* 无序比较完整组列表与属性，包含登录组；重复安全标识符不被近似合并。 */
static BOOL token_groups_equal(const TOKEN_GROUPS *left, const TOKEN_GROUPS *right)
{
    DWORD i, j;
    if (left->GroupCount != right->GroupCount) return FALSE;
    for (i = 0; i < left->GroupCount; ++i) {
        for (j = 0; j < right->GroupCount; ++j) {
            if (EqualSid(left->Groups[i].Sid, right->Groups[j].Sid) &&
                left->Groups[i].Attributes == right->Groups[j].Attributes) break;
        }
        if (j == right->GroupCount) return FALSE;
        for (j = i + 1; j < left->GroupCount; ++j)
            if (EqualSid(left->Groups[i].Sid, left->Groups[j].Sid)) return FALSE;
    }
    return TRUE;
}

/* 比较实际模拟方和服务主令牌的权限、登录身份与会话，不使用较弱替代主体。 */
static BOOL service_tokens_match(HANDLE expected, HANDLE actual)
{
    AwrTokenView left, right;
    DWORD i, j;
    DWORD error;
    BOOL valid = FALSE;
    if (!read_token_view(expected, &left)) return FALSE;
    if (!read_token_view(actual, &right)) {
        error = GetLastError();
        free_token_view(&left);
        SetLastError(error);
        return FALSE;
    }
    if (!EqualSid(left.user->User.Sid, right.user->User.Sid) ||
        left.user->User.Attributes != right.user->User.Attributes ||
        left.session != right.session ||
        !luid_equal(&left.statistics.AuthenticationId,
                    &right.statistics.AuthenticationId) ||
        !EqualSid(left.label->Label.Sid, right.label->Label.Sid) ||
        left.label->Label.Attributes != right.label->Label.Attributes ||
        left.policy.Policy != right.policy.Policy ||
        !token_groups_equal(left.groups, right.groups) ||
        !token_groups_equal(left.restricted, right.restricted) ||
        left.privileges->PrivilegeCount != right.privileges->PrivilegeCount)
        goto cleanup;
    for (i = 0; i < left.privileges->PrivilegeCount; ++i) {
        for (j = 0; j < right.privileges->PrivilegeCount; ++j) {
            if (luid_equal(&left.privileges->Privileges[i].Luid,
                           &right.privileges->Privileges[j].Luid) &&
                left.privileges->Privileges[i].Attributes ==
                    right.privileges->Privileges[j].Attributes) break;
        }
        if (j == right.privileges->PrivilegeCount) goto cleanup;
    }
    valid = TRUE;
cleanup:
    free_token_view(&left);
    free_token_view(&right);
    return valid ? TRUE : invalid_data();
}

/* 读取真正线程模拟令牌并对照拟运行服务主体；OpenAsSelf仅用于该只读查询。 */
static BOOL verify_matching_thread_token(HANDLE limited, PSID user_sid,
                                         const LUID *change_notify)
{
    HANDLE thread_token = NULL;
    BOOL valid;
    DWORD error;
    if (!OpenThreadToken(GetCurrentThread(), TOKEN_QUERY, TRUE, &thread_token))
        return FALSE;
    valid = verify_limited_token(thread_token, user_sid, change_notify,
                                  TokenImpersonation) &&
            service_tokens_match(limited, thread_token);
    error = GetLastError();
    CloseHandle(thread_token);
    if (!valid) SetLastError(error);
    return valid;
}

/* 在受限上下文用新的读取句柄核对父编号仍指向同一进程、线程和原主令牌。 */
static BOOL fresh_parent_identity_matches(const AwrParentState *parent)
{
    HANDLE process = NULL;
    HANDLE token = NULL;
    HANDLE thread = NULL;
    FILETIME creation;
    TOKEN_STATISTICS statistics;
    DWORD i;
    DWORD error = ERROR_INVALID_DATA;
    BOOL valid = FALSE;
    process = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, FALSE, parent->id);
    if (process == NULL || !process_creation(process, &creation) ||
        !OpenProcessToken(process, TOKEN_QUERY, &token) ||
        !query_fixed_token_information(token, TokenStatistics, &statistics,
                                       sizeof(statistics))) {
        error = GetLastError();
        goto cleanup;
    }
    if (CompareFileTime(&creation, &parent->creation) != 0 ||
        !luid_equal(&statistics.TokenId, &parent->token_id)) goto cleanup;
    for (i = 0; i < parent->thread_count; ++i) {
        thread = OpenThread(THREAD_QUERY_LIMITED_INFORMATION, FALSE,
                             parent->threads[i].id);
        if (thread == NULL || !thread_creation(thread, &creation)) {
            error = GetLastError();
            goto cleanup;
        }
        CloseHandle(thread);
        thread = NULL;
        if (CompareFileTime(&creation, &parent->threads[i].creation) != 0)
            goto cleanup;
    }
    if (!parent_threads_unchanged(parent)) { error = GetLastError(); goto cleanup; }
    valid = TRUE;
cleanup:
    if (thread != NULL) CloseHandle(thread);
    if (token != NULL) CloseHandle(token);
    if (process != NULL) CloseHandle(process);
    if (!valid) SetLastError(error);
    return valid;
}

/* 单一危险位只能以明确的系统访问拒绝关闭；成功取得句柄立即关闭并失败。 */
static BOOL handle_request_denied(HANDLE obtained, DWORD error)
{
    if (obtained != NULL) {
        CloseHandle(obtained);
        SetLastError(ERROR_INVALID_ACCESS);
        return FALSE;
    }
    if (error != ERROR_ACCESS_DENIED) {
        SetLastError(error == ERROR_SUCCESS ? ERROR_INVALID_DATA : error);
        return FALSE;
    }
    return TRUE;
}

/* 临时模拟唯一受限主体，逐个权限位向实际父重新请求访问，所有路径恢复原线程。 */
static BOOL check_parent_access_denied(const AwrParentState *parent,
                                       HANDLE limited, PSID user_sid,
                                       const LUID *change_notify)
{
    static const DWORD process_rights[] = {
        PROCESS_CREATE_THREAD, PROCESS_VM_OPERATION, PROCESS_VM_WRITE,
        PROCESS_DUP_HANDLE, PROCESS_CREATE_PROCESS, PROCESS_SET_INFORMATION,
        PROCESS_SET_QUOTA, PROCESS_SUSPEND_RESUME, PROCESS_TERMINATE,
        WRITE_DAC, WRITE_OWNER
    };
    static const DWORD thread_rights[] = {
        THREAD_SET_CONTEXT, THREAD_IMPERSONATE, THREAD_DIRECT_IMPERSONATION,
        THREAD_SET_INFORMATION, THREAD_SUSPEND_RESUME, THREAD_TERMINATE,
        WRITE_DAC, WRITE_OWNER
    };
    static const DWORD token_rights[] = {
        TOKEN_DUPLICATE, TOKEN_IMPERSONATE, TOKEN_ASSIGN_PRIMARY,
        TOKEN_ADJUST_PRIVILEGES, TOKEN_ADJUST_GROUPS, TOKEN_ADJUST_DEFAULT,
        TOKEN_ADJUST_SESSIONID, WRITE_DAC, WRITE_OWNER
    };
    HANDLE impersonation = NULL;
    HANDLE obtained = NULL;
    HANDLE fresh_process = NULL;
    HANDLE remaining_thread_token = NULL;
    DWORD i, j;
    DWORD error = ERROR_INVALID_DATA;
    DWORD access_error;
    BOOL attempted = FALSE;
    BOOL valid = FALSE;
    if (!DuplicateTokenEx(limited, TOKEN_QUERY | TOKEN_IMPERSONATE, NULL,
                          SecurityImpersonation, TokenImpersonation,
                          &impersonation)) return FALSE;
    attempted = TRUE;
    if (!SetThreadToken(NULL, impersonation)) { error = GetLastError(); goto cleanup; }
    if (!verify_matching_thread_token(limited, user_sid, change_notify) ||
        !fresh_parent_identity_matches(parent)) { error = GetLastError(); goto cleanup; }
    /* 这里绝不借用初始高权限句柄，亦不实施写入、注入或令牌复制操作。 */
    for (i = 0; i < sizeof(process_rights) / sizeof(process_rights[0]); ++i) {
        obtained = OpenProcess(process_rights[i], FALSE, parent->id);
        access_error = GetLastError();
        if (!handle_request_denied(obtained, access_error)) {
            obtained = NULL;
            error = GetLastError();
            goto cleanup;
        }
        obtained = NULL;
    }
    for (j = 0; j < parent->thread_count; ++j) {
        for (i = 0; i < sizeof(thread_rights) / sizeof(thread_rights[0]); ++i) {
            obtained = OpenThread(thread_rights[i], FALSE, parent->threads[j].id);
            access_error = GetLastError();
            if (!handle_request_denied(obtained, access_error)) {
                obtained = NULL;
                error = GetLastError();
                goto cleanup;
            }
            obtained = NULL;
        }
    }
    for (i = 0; i < sizeof(token_rights) / sizeof(token_rights[0]); ++i) {
        fresh_process = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, FALSE,
                                      parent->id);
        if (fresh_process == NULL) { error = GetLastError(); goto cleanup; }
        obtained = NULL;
        if (OpenProcessToken(fresh_process, token_rights[i], &obtained)) {
            access_error = ERROR_SUCCESS;
        } else {
            access_error = GetLastError();
        }
        CloseHandle(fresh_process);
        fresh_process = NULL;
        if (!handle_request_denied(obtained, access_error)) {
            obtained = NULL;
            error = GetLastError();
            goto cleanup;
        }
        obtained = NULL;
    }
    if (!verify_matching_thread_token(limited, user_sid, change_notify) ||
        !fresh_parent_identity_matches(parent)) { error = GetLastError(); goto cleanup; }
    valid = TRUE;
cleanup:
    if (obtained != NULL) CloseHandle(obtained);
    if (fresh_process != NULL) CloseHandle(fresh_process);
    /* 入口已证明原线程无模拟。恢复失败必须阻止创建子进程，不能继续持权路径。 */
    if (attempted) {
        if (!RevertToSelf()) {
            error = GetLastError();
            valid = FALSE;
        } else if (OpenThreadToken(GetCurrentThread(), TOKEN_QUERY, TRUE,
                                    &remaining_thread_token)) {
            CloseHandle(remaining_thread_token);
            error = ERROR_BAD_IMPERSONATION_LEVEL;
            valid = FALSE;
        } else if (GetLastError() != ERROR_NO_TOKEN) {
            error = GetLastError();
            valid = FALSE;
        }
    }
    CloseHandle(impersonation);
    if (!valid) SetLastError(error);
    return valid;
}

/* 绑定路径只接受本机绝对盘符路径，不接受继承环境、相对路径或运行覆盖。 */
static BOOL absolute_bound_path(const WCHAR *path)
{
    return path[0] != L'\0' && path[1] == L':' && path[2] == L'\\' &&
           ((path[0] >= L'A' && path[0] <= L'Z') ||
            (path[0] >= L'a' && path[0] <= L'z'));
}

/* 核对编译绑定的基本结构；完整有序命令由普通构建器冻结，不从文件补读。 */
static BOOL bindings_are_valid(void)
{
    return AWR_PORT == 4317 && AWR_USER_SID[0] != L'\0' &&
           wcslen(AWR_USER_SID) < 256 &&
           absolute_bound_path(AWR_PROJECT_ROOT) &&
           absolute_bound_path(AWR_NODE_PATH) &&
           absolute_bound_path(AWR_RUNNER_PATH) &&
           absolute_bound_path(AWR_REGISTRY_PATH) &&
           absolute_bound_path(AWR_STATE_DIRECTORY) &&
           absolute_bound_path(AWR_LAUNCHER_PATH) &&
           absolute_bound_path(AWR_TEMP_DIRECTORY) &&
           AWR_COMMAND_LINE[0] == L'"' &&
           wcslen(AWR_COMMAND_LINE) < 32767;
}

/* 主模块必须位于编译固定的管理员保护路径；构建目录产物不能直接运行服务。 */
static BOOL verify_self_path(void)
{
    WCHAR module_path[32768];
    DWORD length = GetModuleFileNameW(NULL, module_path,
                                     sizeof(module_path) / sizeof(module_path[0]));
    if (length == 0) return FALSE;
    if (length >= sizeof(module_path) / sizeof(module_path[0])) return invalid_data();
    return lstrcmpiW(module_path, AWR_LAUNCHER_PATH) == 0 ? TRUE : invalid_data();
}

/* 将单个固定环境项写入已准确分配的连续缓冲，不读取父进程环境。 */
static void append_environment_entry(WCHAR **cursor, const WCHAR *name,
                                      const WCHAR *value)
{
    size_t name_length = wcslen(name);
    size_t value_length = wcslen(value);
    memcpy(*cursor, name, name_length * sizeof(WCHAR));
    *cursor += name_length;
    *(*cursor)++ = L'=';
    memcpy(*cursor, value, value_length * sizeof(WCHAR));
    *cursor += value_length;
    *(*cursor)++ = L'\0';
}

/* 主动重建排序的允许名单环境；系统目录来自系统接口，临时目录来自固定绑定。 */
static BOOL build_child_environment(WCHAR **environment)
{
    WCHAR windows_directory[32768];
    WCHAR system_directory[32768];
    UINT windows_length;
    UINT system_length;
    size_t characters;
    WCHAR *cursor;
    *environment = NULL;
    windows_length = GetSystemWindowsDirectoryW(windows_directory,
        sizeof(windows_directory) / sizeof(windows_directory[0]));
    if (windows_length == 0) return FALSE;
    system_length = GetSystemDirectoryW(system_directory,
        sizeof(system_directory) / sizeof(system_directory[0]));
    if (system_length == 0) return FALSE;
    if (windows_length >= sizeof(windows_directory) / sizeof(windows_directory[0]) ||
        system_length >= sizeof(system_directory) / sizeof(system_directory[0]))
        return invalid_data();
    characters = wcslen(L"PATH=") + system_length + 1 +
                 wcslen(L"SystemRoot=") + windows_length + 1 +
                 wcslen(L"TEMP=") + wcslen(AWR_TEMP_DIRECTORY) + 1 +
                 wcslen(L"TMP=") + wcslen(AWR_TEMP_DIRECTORY) + 1 +
                 wcslen(L"WINDIR=") + windows_length + 1 + 1;
    if (characters > 32767) return invalid_data();
    *environment = HeapAlloc(GetProcessHeap(), HEAP_ZERO_MEMORY,
                              characters * sizeof(WCHAR));
    if (*environment == NULL) {
        SetLastError(ERROR_NOT_ENOUGH_MEMORY);
        return FALSE;
    }
    cursor = *environment;
    append_environment_entry(&cursor, L"PATH", system_directory);
    append_environment_entry(&cursor, L"SystemRoot", windows_directory);
    append_environment_entry(&cursor, L"TEMP", AWR_TEMP_DIRECTORY);
    append_environment_entry(&cursor, L"TMP", AWR_TEMP_DIRECTORY);
    append_environment_entry(&cursor, L"WINDIR", windows_directory);
    *cursor = L'\0';
    return TRUE;
}

/* 仅从已加载且物理系统路径读回相符的 kernel32 获取固定扩展接口。 */
static BOOL load_attribute_apis(AwrAttributeApis *apis)
{
    HMODULE kernel;
    WCHAR module_path[32768];
    WCHAR system_path[32768];
    DWORD module_length;
    UINT system_length;
    static const WCHAR suffix[] = L"\\kernel32.dll";
    ZeroMemory(apis, sizeof(*apis));
    kernel = GetModuleHandleW(L"kernel32.dll");
    if (kernel == NULL) return FALSE;
    module_length = GetModuleFileNameW(kernel, module_path,
        sizeof(module_path) / sizeof(module_path[0]));
    if (module_length == 0) return FALSE;
    system_length = GetSystemWow64DirectoryW(system_path,
        sizeof(system_path) / sizeof(system_path[0]));
    if (system_length == 0) return FALSE;
    if (module_length >= sizeof(module_path) / sizeof(module_path[0]) ||
        system_length + wcslen(suffix) >=
            sizeof(system_path) / sizeof(system_path[0])) return invalid_data();
    memcpy(system_path + system_length, suffix, sizeof(suffix));
    if (lstrcmpiW(module_path, system_path) != 0) return invalid_data();
    /* 仅转换固定导出地址，未使用 LoadLibrary 或用户可写的动态链接库路径。 */
    apis->initialize = (AwrInitializeAttributes)
        GetProcAddress(kernel, "InitializeProcThreadAttributeList");
    apis->update = (AwrUpdateAttribute)
        GetProcAddress(kernel, "UpdateProcThreadAttribute");
    apis->destroy = (AwrDeleteAttributes)
        GetProcAddress(kernel, "DeleteProcThreadAttributeList");
    apis->is_process_in_job = (AwrIsProcessInJob)
        GetProcAddress(kernel, "IsProcessInJob");
    if (apis->initialize == NULL || apis->update == NULL || apis->destroy == NULL ||
        apis->is_process_in_job == NULL) {
        SetLastError(ERROR_PROC_NOT_FOUND);
        return FALSE;
    }
    return TRUE;
}

/* 创建子之后、恢复之前再次只读核对父对象契约，仍不补写描述符或原主令牌。 */
static BOOL recheck_parent_objects(const AwrParentState *parent, PSID user_sid)
{
    HANDLE token = NULL;
    TOKEN_STATISTICS statistics;
    DWORD i;
    DWORD error = ERROR_INVALID_DATA;
    BOOL valid = FALSE;
    if (!OpenProcessToken(parent->process, TOKEN_QUERY | READ_CONTROL, &token) ||
        !query_fixed_token_information(token, TokenStatistics, &statistics,
                                       sizeof(statistics)) ||
        !verify_parent_token(token, user_sid) ||
        !verify_object_label(token) || !verify_object_label(parent->process) ||
        !parent_threads_unchanged(parent)) { error = GetLastError(); goto cleanup; }
    if (!luid_equal(&statistics.TokenId, &parent->token_id)) goto cleanup;
    for (i = 0; i < parent->thread_count; ++i) {
        FILETIME creation;
        if (!thread_creation(parent->threads[i].handle, &creation) ||
            !verify_object_label(parent->threads[i].handle)) {
            error = GetLastError();
            goto cleanup;
        }
        if (CompareFileTime(&creation, &parent->threads[i].creation) != 0)
            goto cleanup;
    }
    valid = TRUE;
cleanup:
    if (token != NULL) CloseHandle(token);
    if (!valid) SetLastError(error);
    return valid;
}

/* 创建阶段关联唯一非继承作业；挂起实际子令牌核验后才运行，等待并返回真实退出码。 */
static DWORD launch_service(const AwrParentState *parent, HANDLE limited,
                            PSID user_sid, const LUID *change_notify)
{
    AwrAttributeApis apis;
    AwrStartupInfoEx startup;
    JOBOBJECT_EXTENDED_LIMIT_INFORMATION limits;
    PROCESS_INFORMATION child;
    HANDLE job = NULL;
    HANDLE jobs[1];
    HANDLE child_token = NULL;
    WCHAR *environment = NULL;
    WCHAR *command = NULL;
    void *attributes = NULL;
    SIZE_T attribute_bytes = 0;
    BOOL attributes_initialized = FALSE;
    BOOL in_job = FALSE;
    BOOL completed = FALSE;
    DWORD result;
    DWORD error;
    DWORD wait_result;
    DWORD suspend_count;
    enum AwrStage stage = AWR_STAGE_ENVIRONMENT;
    ZeroMemory(&child, sizeof(child));
    ZeroMemory(&startup, sizeof(startup));
    ZeroMemory(&limits, sizeof(limits));
    if (!build_child_environment(&environment)) goto failure;
    command = HeapAlloc(GetProcessHeap(), 0,
                        (wcslen(AWR_COMMAND_LINE) + 1) * sizeof(WCHAR));
    if (command == NULL) { SetLastError(ERROR_NOT_ENOUGH_MEMORY); goto failure; }
    memcpy(command, AWR_COMMAND_LINE,
           (wcslen(AWR_COMMAND_LINE) + 1) * sizeof(WCHAR));
    stage = AWR_STAGE_SYSTEM_EXPORTS;
    if (!load_attribute_apis(&apis)) goto failure;
    stage = AWR_STAGE_JOB_CREATE;
    job = CreateJobObjectW(NULL, NULL);
    if (job == NULL) goto failure;
    stage = AWR_STAGE_JOB_LIMIT;
    limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
    if (!SetInformationJobObject(job, JobObjectExtendedLimitInformation,
                                  &limits, sizeof(limits))) goto failure;
    stage = AWR_STAGE_ATTRIBUTES;
    if (apis.initialize(NULL, 1, 0, &attribute_bytes) ||
        GetLastError() != ERROR_INSUFFICIENT_BUFFER || attribute_bytes == 0 ||
        attribute_bytes > 1024UL * 1024UL) { invalid_data(); goto failure; }
    attributes = HeapAlloc(GetProcessHeap(), HEAP_ZERO_MEMORY, attribute_bytes);
    if (attributes == NULL) { SetLastError(ERROR_NOT_ENOUGH_MEMORY); goto failure; }
    if (!apis.initialize(attributes, 1, 0, &attribute_bytes)) goto failure;
    attributes_initialized = TRUE;
    stage = AWR_STAGE_JOB_ATTRIBUTE;
    jobs[0] = job;
    /* jobs数组活到属性列表释放；它不是继承句柄列表，也不允许子进程脱离。 */
    if (!apis.update(attributes, 0, PROC_THREAD_ATTRIBUTE_JOB_LIST,
                       jobs, sizeof(jobs), NULL, NULL)) goto failure;
    startup.StartupInfo.cb = sizeof(startup);
    startup.lpAttributeList = attributes;
    stage = AWR_STAGE_CHILD_CREATE;
    if (!CreateProcessAsUserW(limited, AWR_NODE_PATH, command, NULL, NULL, FALSE,
        CREATE_SUSPENDED | CREATE_NO_WINDOW | CREATE_UNICODE_ENVIRONMENT |
            EXTENDED_STARTUPINFO_PRESENT,
        environment, AWR_PROJECT_ROOT, &startup.StartupInfo, &child)) goto failure;
    /* 删除的是用户态属性缓冲，不关闭本次唯一作业句柄；无事后关联回退。 */
    apis.destroy(attributes);
    attributes_initialized = FALSE;
    HeapFree(GetProcessHeap(), 0, attributes);
    attributes = NULL;
    stage = AWR_STAGE_CHILD_JOB;
    if (!apis.is_process_in_job(child.hProcess, job, &in_job)) goto failure;
    if (!in_job) { invalid_data(); goto failure; }
    stage = AWR_STAGE_CHILD_TOKEN;
    if (!OpenProcessToken(child.hProcess, TOKEN_QUERY | TOKEN_DUPLICATE,
                           &child_token)) goto failure;
    stage = AWR_STAGE_CHILD_VERIFY;
    if (!verify_limited_token(child_token, user_sid, change_notify, TokenPrimary) ||
        !service_tokens_match(limited, child_token)) goto failure;
    stage = AWR_STAGE_PARENT_RECHECK;
    if (!recheck_parent_objects(parent, user_sid)) goto failure;
    stage = AWR_STAGE_CHILD_RESUME;
    suspend_count = ResumeThread(child.hThread);
    if (suspend_count == (DWORD)-1) goto failure;
    if (suspend_count != 1) { invalid_data(); goto failure; }
    stage = AWR_STAGE_CHILD_WAIT;
    wait_result = WaitForSingleObject(child.hProcess, INFINITE);
    if (wait_result != WAIT_OBJECT_0) {
        if (wait_result != WAIT_FAILED) invalid_data();
        goto failure;
    }
    stage = AWR_STAGE_CHILD_EXIT;
    if (!GetExitCodeProcess(child.hProcess, &result)) goto failure;
    completed = TRUE;
    goto cleanup;
failure:
    error = GetLastError();
    result = encode_failure(stage, error);
cleanup:
    /* 只清理本次创建句柄。父异常退出时系统关闭唯一作业句柄同样结束子树。 */
    if (child.hProcess != NULL && !completed) TerminateProcess(child.hProcess, result);
    if (job != NULL) CloseHandle(job);
    if (child.hProcess != NULL && !completed) WaitForSingleObject(child.hProcess, INFINITE);
    if (child_token != NULL) CloseHandle(child_token);
    if (child.hThread != NULL) CloseHandle(child.hThread);
    if (child.hProcess != NULL) CloseHandle(child.hProcess);
    if (attributes_initialized) apis.destroy(attributes);
    if (attributes != NULL) HeapFree(GetProcessHeap(), 0, attributes);
    if (environment != NULL) HeapFree(GetProcessHeap(), 0, environment);
    if (command != NULL) HeapFree(GetProcessHeap(), 0, command);
    return result;
}

/* 唯一固定生产链入口；所有父和受限主体门禁通过后才允许进入创建子进程路径。 */
static DWORD awr_launch(void)
{
    AwrParentState parent;
    PSID user_sid = NULL;
    HANDLE limited = NULL;
    LUID change_notify;
    WCHAR sid_text[256];
    DWORD result;
    enum AwrStage stage = AWR_STAGE_BINDING;
    ZeroMemory(&parent, sizeof(parent));
    if (!bindings_are_valid()) { invalid_data(); goto failure; }
    stage = AWR_STAGE_SELF_PATH;
    if (!verify_self_path()) goto failure;
    stage = AWR_STAGE_BINDING;
    /* 旧头误声明为可写字符串；使用有界本地副本，不移除固定常量的只读限定。 */
    memcpy(sid_text, AWR_USER_SID, (wcslen(AWR_USER_SID) + 1) * sizeof(WCHAR));
    if (!ConvertStringSidToSidW(sid_text, &user_sid)) goto failure;
    stage = AWR_STAGE_PARENT;
    if (!check_parent_objects(&parent, user_sid)) goto failure;
    stage = AWR_STAGE_CHANGE_NOTIFY;
    if (!LookupPrivilegeValueW(NULL, L"SeChangeNotifyPrivilege", &change_notify))
        goto failure;
    stage = AWR_STAGE_LIMITED_CREATE;
    if (!create_limited_token(parent.token, user_sid, &change_notify, &limited))
        goto failure;
    stage = AWR_STAGE_LIMITED_VERIFY;
    if (!verify_limited_token(limited, user_sid, &change_notify, TokenPrimary))
        goto failure;
    stage = AWR_STAGE_PARENT_ACCESS;
    if (!check_parent_access_denied(&parent, limited, user_sid, &change_notify))
        goto failure;
    result = launch_service(&parent, limited, user_sid, &change_notify);
    goto cleanup;
failure:
    result = encode_failure(stage, GetLastError());
cleanup:
    if (limited != NULL) CloseHandle(limited);
    if (user_sid != NULL) LocalFree(user_sid);
    free_parent_state(&parent);
    return result;
}

/* 额外参数没有解释或覆盖机会；ExitProcess保留服务真实32位退出码。 */
int main(int argc, char **argv)
{
    DWORD result;
    (void)argv;
    if (argc != 1) result = encode_failure(AWR_STAGE_ARGUMENTS, ERROR_INVALID_PARAMETER);
    else result = awr_launch();
    ExitProcess(result);
    return 0;
}
