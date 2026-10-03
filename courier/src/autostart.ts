// file: courier/src/autostart.ts
import { execFileSync } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, posix, win32 } from "node:path";

// Start-at-login (spec D6): opt-in, default NO, never silent. Each OS gets a
// PURE plan (files + commands + plain-language description) so the exact
// effect can be printed and tested without registering anything. System tools
// are called by FULL path: on Windows, Git Bash's GNU tools have shadowed
// Windows ones before.

export interface AutostartContext {
  platform: NodeJS.Platform;
  /** The node executable (process.execPath). */
  nodePath: string;
  /** courier/dist/bin.js */
  binPath: string;
  home: string;
  env: NodeJS.ProcessEnv;
  /** Where the Windows task definition is kept (the courier folder). */
  courierDir: string;
  /** Where launchd sends the courier's output (macOS). */
  logPath: string;
  /** macOS: the user's uid, for launchctl's gui/<uid> domain. */
  uid?: number;
  /** Linux: the systemctl binary. */
  systemctl?: string;
}

export interface Command { file: string; args: string[] }

export interface AutostartPlan {
  kind: "windows-task" | "launchd" | "systemd-user";
  name: string;
  files: Array<{ path: string; content: Buffer }>;
  install: Command[];
  /** Run before the files are deleted. */
  remove: Command[];
  /** Run after the files are deleted. */
  afterRemove: Command[];
  /** Printed by setup and `autostart on|off`: what, where, how to remove. */
  describe: string[];
}

export const TASK_NAME = "CollabSync";
export const LAUNCHD_LABEL = "com.collab.sync";
export const SYSTEMD_UNIT = "collab-sync.service";

const xml = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

export function autostartPlan(c: AutostartContext): AutostartPlan {
  if (c.platform === "win32") {
    const schtasks = win32.join(c.env.SystemRoot || c.env.windir || "C:\\Windows", "System32", "schtasks.exe");
    const user = c.env.USERDOMAIN && c.env.USERNAME ? `${c.env.USERDOMAIN}\\${c.env.USERNAME}` : c.env.USERNAME ?? "";
    const xmlPath = win32.join(c.courierDir, "collab-sync-task.xml");
    // A LogonTrigger limited to this user + LeastPrivilege: a standard user can
    // register it (schtasks /SC ONLOGON without /XML needs admin rights).
    const body = [
      `<?xml version="1.0" encoding="UTF-16"?>`,
      `<Task version="1.2" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">`,
      `  <RegistrationInfo>`,
      `    <Description>Collab notes sync: starts the courier when you log in. Remove with: collab sync autostart off</Description>`,
      `  </RegistrationInfo>`,
      `  <Triggers>`,
      `    <LogonTrigger>`,
      `      <Enabled>true</Enabled>`,
      `      <UserId>${xml(user)}</UserId>`,
      `    </LogonTrigger>`,
      `  </Triggers>`,
      `  <Principals>`,
      `    <Principal id="Author">`,
      `      <UserId>${xml(user)}</UserId>`,
      `      <LogonType>InteractiveToken</LogonType>`,
      `      <RunLevel>LeastPrivilege</RunLevel>`,
      `    </Principal>`,
      `  </Principals>`,
      `  <Settings>`,
      `    <MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>`,
      `    <DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>`,
      `    <StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>`,
      `    <ExecutionTimeLimit>PT0S</ExecutionTimeLimit>`,
      `    <Enabled>true</Enabled>`,
      `  </Settings>`,
      `  <Actions Context="Author">`,
      `    <Exec>`,
      `      <Command>${xml(c.nodePath)}</Command>`,
      `      <Arguments>${xml(`"${c.binPath}" sync start`)}</Arguments>`,
      `    </Exec>`,
      `  </Actions>`,
      `</Task>`,
      ``,
    ].join("\r\n");
    // schtasks reads an XML task definition as UTF-16 (little-endian, with BOM).
    const content = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(body, "utf16le")]);
    return {
      kind: "windows-task",
      name: TASK_NAME,
      files: [{ path: xmlPath, content }],
      install: [{ file: schtasks, args: ["/Create", "/TN", TASK_NAME, "/XML", xmlPath, "/F"] }],
      remove: [{ file: schtasks, args: ["/Delete", "/TN", TASK_NAME, "/F"] }],
      afterRemove: [],
      describe: [
        `Windows Task Scheduler task "${TASK_NAME}": at your logon, as you, without admin rights, runs`,
        `  "${c.nodePath}" "${c.binPath}" sync start`,
        `its definition is kept at ${xmlPath}`,
        `remove it with: collab sync autostart off   (or: "${schtasks}" /Delete /TN ${TASK_NAME} /F)`,
      ],
    };
  }

  if (c.platform === "darwin") {
    const plist = posix.join(c.home, "Library", "LaunchAgents", `${LAUNCHD_LABEL}.plist`);
    const body = [
      `<?xml version="1.0" encoding="UTF-8"?>`,
      `<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">`,
      `<plist version="1.0">`,
      `<dict>`,
      `  <key>Label</key><string>${LAUNCHD_LABEL}</string>`,
      `  <key>ProgramArguments</key>`,
      `  <array>`,
      `    <string>${xml(c.nodePath)}</string>`,
      `    <string>${xml(c.binPath)}</string>`,
      `    <string>sync</string>`,
      `    <string>run</string>`,
      `  </array>`,
      `  <key>RunAtLoad</key><true/>`,
      `  <key>StandardOutPath</key><string>${xml(c.logPath)}</string>`,
      `  <key>StandardErrorPath</key><string>${xml(c.logPath)}</string>`,
      `</dict>`,
      `</plist>`,
      ``,
    ].join("\n");
    return {
      kind: "launchd",
      name: LAUNCHD_LABEL,
      files: [{ path: plist, content: Buffer.from(body, "utf8") }],
      install: [], // ~/Library/LaunchAgents is read at login: the file is the registration
      remove: [{ file: "/bin/launchctl", args: ["bootout", `gui/${c.uid ?? 501}/${LAUNCHD_LABEL}`] }],
      afterRemove: [],
      describe: [
        `macOS LaunchAgent ${LAUNCHD_LABEL}: at your next login, runs "${c.nodePath}" "${c.binPath}" sync run`,
        `file: ${plist}`,
        `remove it with: collab sync autostart off   (or delete that file)`,
      ],
    };
  }

  // Linux (and other Unixes with systemd): a user unit, no root needed.
  const unitDir = posix.join(c.env.XDG_CONFIG_HOME || posix.join(c.home, ".config"), "systemd", "user");
  const unit = posix.join(unitDir, SYSTEMD_UNIT);
  const systemctl = c.systemctl ?? "/usr/bin/systemctl";
  // systemd unit quoting: "..." with \\ and \" escaped; % is a specifier, so %%.
  const q = (s: string) => `"${s.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/%/g, "%%")}"`;
  const body = [
    `[Unit]`,
    `Description=Collab notes sync courier (remove with: collab sync autostart off)`,
    ``,
    `[Service]`,
    `ExecStart=${q(c.nodePath)} ${q(c.binPath)} sync run`,
    `Restart=on-failure`,
    `RestartSec=30`,
    ``,
    `[Install]`,
    `WantedBy=default.target`,
    ``,
  ].join("\n");
  return {
    kind: "systemd-user",
    name: SYSTEMD_UNIT,
    files: [{ path: unit, content: Buffer.from(body, "utf8") }],
    install: [
      { file: systemctl, args: ["--user", "daemon-reload"] },
      { file: systemctl, args: ["--user", "enable", SYSTEMD_UNIT] },
    ],
    remove: [{ file: systemctl, args: ["--user", "disable", SYSTEMD_UNIT] }],
    afterRemove: [{ file: systemctl, args: ["--user", "daemon-reload"] }],
    describe: [
      `systemd user unit ${SYSTEMD_UNIT} (enabled: starts at your login), runs "${c.nodePath}" "${c.binPath}" sync run`,
      `file: ${unit}`,
      `remove it with: collab sync autostart off   (or: systemctl --user disable ${SYSTEMD_UNIT} and delete that file)`,
    ],
  };
}

export interface AutostartDeps {
  run?: (c: Command) => void;
  write?: (path: string, content: Buffer) => void;
  remove?: (path: string) => void;
}

const real: Required<AutostartDeps> = {
  run: (c) => { execFileSync(c.file, c.args, { stdio: "pipe", windowsHide: true }); },
  write: (path, content) => { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, content); },
  remove: (path) => rmSync(path, { force: true }),
};

export function installAutostart(plan: AutostartPlan, deps: AutostartDeps = {}): void {
  const d = { ...real, ...deps };
  for (const f of plan.files) d.write(f.path, f.content);
  for (const c of plan.install) {
    try {
      d.run(c);
    } catch (e) {
      throw new Error(`could not register start-at-login (${c.file} ${c.args.join(" ")}): ${(e as Error).message}`);
    }
  }
}

/** Best effort: removing something already gone is fine. Returns notes about steps that failed. */
export function removeAutostart(plan: AutostartPlan, deps: AutostartDeps = {}): string[] {
  const d = { ...real, ...deps };
  const notes: string[] = [];
  const attempt = (c: Command) => {
    try { d.run(c); } catch (e) { notes.push(`${c.file} ${c.args.join(" ")}: ${(e as Error).message.split("\n")[0]} (already removed?)`); }
  };
  plan.remove.forEach(attempt);
  for (const f of plan.files) d.remove(f.path);
  plan.afterRemove.forEach(attempt);
  return notes;
}
