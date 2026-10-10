// 面接を見られる人(閲覧範囲)。API の入口と、お知らせの宛先の両方で使う。

import type { Interview } from "../src/shared/types";
import type { AppContext } from "./context";
import type { UserRecord } from "./store";

/**
 * この面接を見られるか。管理者はすべて。面接官は、設定で「担当の面接だけ」にしていれば
 * 面接官に選ばれた面接と自分が登録した面接だけ
 */
export function canView(app: AppContext, user: Pick<UserRecord, "id" | "role">, iv: Pick<Interview, "interviewerIds" | "createdBy">): boolean {
  if (user.role === "admin") return true;
  if (app.store.settings.access.interviewerScope === "all") return true;
  return iv.interviewerIds.includes(user.id) || iv.createdBy === user.id;
}

/** 管理者に2段階認証が必須なのに、この人はまだ設定していない */
export function mustSetupTotp(app: AppContext, user: Pick<UserRecord, "role" | "totp">): boolean {
  return user.role === "admin" && app.store.settings.security.requireTotpForAdmins && !user.totp;
}
