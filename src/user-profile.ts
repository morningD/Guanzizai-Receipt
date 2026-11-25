export type MembershipProfile = { id: string; organization: string; website: string; parentId: string; parentName?: string; number: string; level: string; status: string; effectiveDate: string; validUntil: string };

export type UserProfile = {
  avatar: string;
  chineseName: string;
  englishName: string;
  jobTitle: string;
  /** 常住地：判定火车票去程/返程方向；属身份信息而非后端配置。 */
  homeCity: string;
  invoiceTitle: string;
  taxId: string;
  invoiceAddressPhone: string;
  invoiceBankAccount: string;
  schoolSsoAccount: string;
  schoolSsoVerifiedAt: string;
  employeeId: string;
  organization: string;
  signatureUpdated: boolean;
  memberships: MembershipProfile[];
};

export type UserProfileRecord = { id: string; profile: UserProfile; updatedAt: string };

export const USER_PROFILE_KEY = "guanzizai-receipt-user-profile:v1";
export const USER_PROFILES_KEY = "guanzizai-receipt-user-profiles:v1";
export const ACTIVE_USER_PROFILE_KEY = "guanzizai-receipt-active-user-profile:v1";
export const EMPTY_MEMBERSHIP: MembershipProfile = { id: "", organization: "", website: "", parentId: "", number: "", level: "", status: "", effectiveDate: "", validUntil: "" };

export function emptyUserProfile(): UserProfile {
    return {
    avatar: "🙂", chineseName: "", englishName: "", jobTitle: "", homeCity: "", invoiceTitle: "", taxId: "", invoiceAddressPhone: "", invoiceBankAccount: "",
    schoolSsoAccount: "", schoolSsoVerifiedAt: "", employeeId: "", organization: "", signatureUpdated: false,
    memberships: [],
  };
}

export const EMPTY_USER_PROFILE = emptyUserProfile();

function membership(value: unknown, fallback: Partial<MembershipProfile> = {}): MembershipProfile {
  if (!value || typeof value !== "object") return { ...EMPTY_MEMBERSHIP };
  const record = value as Partial<MembershipProfile>;
  const organization = typeof record.organization === "string" ? record.organization : fallback.organization ?? "";
  return {
    id: typeof record.id === "string" && record.id ? record.id : `${organization.toLowerCase().replace(/[^a-z0-9]+/g, "-") || "membership"}-${typeof record.number === "string" ? record.number : "manual"}`,
    organization,
    website: typeof record.website === "string" ? record.website : fallback.website ?? "",
    parentId: typeof record.parentId === "string" ? record.parentId : "",
    parentName: typeof record.parentName === "string" ? record.parentName : "",
    number: typeof record.number === "string" ? record.number : "",
    level: typeof record.level === "string" ? record.level : "",
    status: typeof record.status === "string" ? record.status : "",
    effectiveDate: typeof record.effectiveDate === "string" ? record.effectiveDate : "",
    validUntil: typeof record.validUntil === "string" ? record.validUntil : "",
  };
}

function normalizeProfile(value: unknown): UserProfile {
  const record = value && typeof value === "object" ? value as Partial<UserProfile> & { ieee?: unknown; acm?: unknown; ccf?: unknown; financeAccount?: unknown; foreignAffairsAccount?: unknown } : {};
  const profile = emptyUserProfile();
  for (const key of ["chineseName", "englishName", "jobTitle", "homeCity", "invoiceTitle", "taxId", "invoiceAddressPhone", "invoiceBankAccount", "schoolSsoAccount", "schoolSsoVerifiedAt", "employeeId", "organization"] as const) {
    profile[key] = typeof record[key] === "string" ? record[key] : "";
  }
  if (!profile.schoolSsoAccount) profile.schoolSsoAccount = typeof record.financeAccount === "string" ? record.financeAccount : typeof record.foreignAffairsAccount === "string" ? record.foreignAffairsAccount : "";
  profile.avatar = typeof record.avatar === "string" && record.avatar ? record.avatar : "🙂";
  profile.signatureUpdated = record.signatureUpdated === true;
  if (Array.isArray(record.memberships)) {
    profile.memberships = record.memberships.map((item) => membership(item)).filter((item) => item.organization);
  } else {
    profile.memberships = [
      membership(record.ieee, { organization: "IEEE", website: "https://www.ieee.org/" }),
      membership(record.acm, { organization: "ACM", website: "https://www.acm.org/" }),
      membership(record.ccf, { organization: "CCF", website: "https://passport.ccf.org.cn/" }),
    ].filter((item) => item.number || item.level || item.validUntil);
  }
  return profile;
}

function hasProfileData(profile: UserProfile) {
  return Boolean(profile.chineseName || profile.englishName || profile.invoiceTitle || profile.schoolSsoAccount || profile.signatureUpdated || profile.memberships.length);
}

export function loadUserProfiles(): UserProfileRecord[] {
  try {
    const rawProfiles = localStorage.getItem(USER_PROFILES_KEY);
    if (rawProfiles !== null) {
      const saved = JSON.parse(rawProfiles) as unknown;
      if (Array.isArray(saved)) {
        return saved.flatMap((item) => item && typeof item === "object" && typeof (item as UserProfileRecord).id === "string" ? [{ id: (item as UserProfileRecord).id, profile: normalizeProfile((item as UserProfileRecord).profile), updatedAt: typeof (item as UserProfileRecord).updatedAt === "string" ? (item as UserProfileRecord).updatedAt : "" }] : []);
      }
    }
  } catch { /* migrate legacy data below */ }

  try {
    const legacy = normalizeProfile(JSON.parse(localStorage.getItem(USER_PROFILE_KEY) ?? "{}"));
    return hasProfileData(legacy) ? [{ id: "profile-default", profile: legacy, updatedAt: "" }] : [];
  } catch {
    return [];
  }
}

export function saveUserProfiles(profiles: UserProfileRecord[]) {
  localStorage.setItem(USER_PROFILES_KEY, JSON.stringify(profiles));
}

export function loadActiveUserProfileId() { return localStorage.getItem(ACTIVE_USER_PROFILE_KEY) ?? ""; }
export function saveActiveUserProfileId(id: string) { localStorage.setItem(ACTIVE_USER_PROFILE_KEY, id); }

export function createUserProfile(): UserProfileRecord {
  return { id: `user-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`, profile: emptyUserProfile(), updatedAt: new Date().toISOString() };
}

export function userProfileLabel(record: UserProfileRecord) {
  return record.profile.chineseName || record.profile.englishName || "未命名用户";
}
