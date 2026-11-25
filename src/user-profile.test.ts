import { afterEach, describe, expect, it } from "vitest";
import { ACTIVE_USER_PROFILE_KEY, EMPTY_USER_PROFILE, loadActiveUserProfileId, loadUserProfiles, saveActiveUserProfileId, saveUserProfiles, USER_PROFILE_KEY } from "./user-profile";

describe("用户资料", () => {
  const values = new Map<string, string>();
  Object.defineProperty(globalThis, "localStorage", { configurable: true, value: { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => values.set(key, value), clear: () => values.clear() } });
  afterEach(() => values.clear());

  it("将既有单用户资料迁移为用户列表", () => {
    localStorage.setItem(USER_PROFILE_KEY, JSON.stringify({ ...EMPTY_USER_PROFILE, chineseName: "张三" }));
    expect(loadUserProfiles()).toMatchObject([{ id: "profile-default", profile: { chineseName: "张三", avatar: "🙂" } }]);
  });

  it("将旧的学校系统账号迁移为统一 SSO 账号", () => {
    localStorage.setItem(USER_PROFILE_KEY, JSON.stringify({ ...EMPTY_USER_PROFILE, financeAccount: "ecnu-id" }));
    expect(loadUserProfiles()[0].profile.schoolSsoAccount).toBe("ecnu-id");
  });

  it("保存多个用户及当前用户标识，不包含系统密码", () => {
    saveUserProfiles([{ id: "user-a", profile: { ...EMPTY_USER_PROFILE, chineseName: "张三" }, updatedAt: "2026-08-02" }, { id: "user-b", profile: { ...EMPTY_USER_PROFILE, chineseName: "李四" }, updatedAt: "2026-08-02" }]);
    saveActiveUserProfileId("user-b");
    expect(loadUserProfiles()).toHaveLength(2);
    expect(loadActiveUserProfileId()).toBe("user-b");
    expect(localStorage.getItem(ACTIVE_USER_PROFILE_KEY)).not.toContain("password");
  });

  it("保留子会员与其主会员的关联", () => {
    saveUserProfiles([{
      id: "user-a",
      updatedAt: "2026-08-02",
      profile: {
        ...EMPTY_USER_PROFILE,
        memberships: [
          { id: "ieee-1", organization: "IEEE", website: "", parentId: "", number: "1", level: "", status: "", effectiveDate: "", validUntil: "" },
          { id: "sps", organization: "IEEE Signal Processing Society", website: "", parentId: "ieee-1", number: "", level: "", status: "", effectiveDate: "", validUntil: "" },
        ],
      },
    }]);
    expect(loadUserProfiles()[0].profile.memberships[1].parentId).toBe("ieee-1");
  });
});
