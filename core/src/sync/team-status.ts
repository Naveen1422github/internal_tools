// The post office only sees what each device still has to RECEIVE; what a
// device has not sent yet lives on that device. Its wire values ("up to date",
// "behind") stay for compatibility; people read these words instead (E-739 #3).
export const TEAM_STATUS_NOTE =
  "STATE shows what each device still has to receive. What a device has not sent yet shows on that device: collab sync status";

export function describeMemberState(state: string, behind: number): string {
  if (state === "up to date") return "has everything";
  if (state === "behind") return `${behind} to receive`;
  return state;
}
