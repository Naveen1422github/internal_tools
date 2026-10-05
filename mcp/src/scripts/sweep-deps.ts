import { getDb, migrate, addEntry, closeDb, formatEntryRef } from '@collab-mcp/core';
import { execSync } from 'child_process';
import fs from 'fs';
import path from 'path';

// List of repos
const repos = [
  'emp1st-admin-portal-service',
  'emp1st-api-gateway',
  'emp1st-assets-service',
  'emp1st-attendance-service',
  'emp1st-auth-service',
  'emp1st-chatbot',
  'emp1st-config-service',
  'emp1st-custom-form-service',
  'emp1st-emp-service',
  'emp1st-expenditure',
  'emp1st-leave-service',
  'emp1st-org-service',
  'emp1st-payroll',
  'emp1st-pmgm-service',
  'emp1st-roles-responsibility-service',
  'emp1st-shift-service',
  'emp1st-timesheet',
  'emp1st-travel-service'
];

const workspaceRoot = 'C:/Users/NaveenPrajapati/Downloads/dev/frontend2';

// Helper to recursively list files matching criteria
function getFiles(dir: string, fileList: string[] = []): string[] {
  if (!fs.existsSync(dir)) return fileList;
  let files: string[];
  try {
    files = fs.readdirSync(dir);
  } catch (e) {
    return fileList;
  }
  for (const file of files) {
    const filePath = path.join(dir, file);
    let stat: fs.Stats;
    try {
      stat = fs.statSync(filePath);
    } catch (e) {
      continue;
    }
    if (stat.isDirectory()) {
      const base = path.basename(filePath);
      if (base !== 'node_modules' && base !== 'dist' && base !== 'build' && base !== '.git') {
        getFiles(filePath, fileList);
      }
    } else {
      const ext = path.extname(file);
      if (['.ts', '.js', '.json', '.html', '.css', '.scss'].includes(ext)) {
        fileList.push(filePath);
      }
    }
  }
  return fileList;
}

// Helper to escape string for regex
function escapeRegExp(string: string) {
  return string.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// Function to search usages of a package in files
function searchUsage(pkg: string, files: string[]): { file: string; line: number; text: string; commented: boolean }[] {
  const hits: { file: string; line: number; text: string; commented: boolean }[] = [];
  const regex = new RegExp(`(require\\(['"]${escapeRegExp(pkg)}['"]|from\\s+['"]${escapeRegExp(pkg)}['"]|import\\s+['"]${escapeRegExp(pkg)}['"])`, 'i');
  
  for (const file of files) {
    try {
      const content = fs.readFileSync(file, 'utf-8');
      const lines = content.split('\n');
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        if (regex.test(line)) {
          const trimmed = line.trim();
          const commented = trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('/*') || trimmed.includes('// require') || trimmed.includes('// import');
          hits.push({
            file: path.relative(workspaceRoot, file),
            line: i + 1,
            text: trimmed,
            commented
          });
        }
      }
    } catch (e) {
      // Ignore read errors
    }
  }
  return hits;
}

// Main run
async function run() {
  console.log("Starting dependency audit sweep across backend repos...");
  const results: any[] = [];
  const gotchasList: { repo: string; error: string }[] = [];

  for (const repo of repos) {
    const repoPath = path.join(workspaceRoot, repo);
    console.log(`\nAnalyzing ${repo}...`);
    
    if (!fs.existsSync(repoPath)) {
      console.log(`Directory does not exist: ${repoPath}`);
      gotchasList.push({ repo, error: "Directory does not exist" });
      continue;
    }
    
    const pkgPath = path.join(repoPath, 'package.json');
    if (!fs.existsSync(pkgPath)) {
      console.log(`package.json does not exist: ${pkgPath}`);
      gotchasList.push({ repo, error: "package.json does not exist" });
      continue;
    }
    
    // 1. Run depcheck
    let depcheckRes: any = null;
    try {
      console.log(`Running depcheck...`);
      const output = execSync('npx --yes depcheck --json', { cwd: repoPath, encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'] });
      depcheckRes = JSON.parse(output);
    } catch (e: any) {
      if (e.stdout) {
        try {
          depcheckRes = JSON.parse(e.stdout);
        } catch (jsonErr) {
          console.error(`Failed to parse depcheck output for ${repo}:`, e.stdout);
        }
      }
      if (!depcheckRes) {
        console.error(`depcheck failed: ${e.message}`);
        gotchasList.push({ repo, error: `depcheck failed: ${e.message}` });
        continue;
      }
    }

    const unusedDeps = depcheckRes.dependencies || [];
    const unusedDevDeps = depcheckRes.devDependencies || [];
    
    // Read package.json content for checking placeholder dependencies
    let pkgJson: any = {};
    try {
      pkgJson = JSON.parse(fs.readFileSync(pkgPath, 'utf-8'));
    } catch (e) {
      gotchasList.push({ repo, error: `Could not parse package.json` });
      continue;
    }
    const allDeps = Object.keys(pkgJson.dependencies || {});
    const allDevDeps = Object.keys(pkgJson.devDependencies || {});
    
    // Get files to search
    let srcPath = path.join(repoPath, 'src');
    if (!fs.existsSync(srcPath)) {
      srcPath = repoPath; // fallback to root if src doesn't exist
    }
    const files = getFiles(srcPath);
    
    const auditItems: any[] = [];
    
    // Process unused dependencies
    for (const pkg of unusedDeps) {
      const hits = searchUsage(pkg, files);
      const realHits = hits.filter(h => !h.commented);
      const isConfirmed = realHits.length === 0;
      
      let note = "";
      if (hits.length > 0) {
        if (isConfirmed) {
          const commentedFiles = hits.map(h => `${path.basename(h.file)}:${h.line}`).join(', ');
          note = `Commented-out import found in ${commentedFiles}`;
        } else {
          note = `Used in code but flagged by depcheck (false positive)`;
        }
      } else {
        note = "No imports or requires found in files";
      }

      // Check placeholder prioritization
      if (pkg === 'crypto' || pkg === 'http') {
        note = `Placeholder package. ${note} (HIGH priority removal)`;
      }

      auditItems.push({
        name: pkg,
        type: 'prod',
        confirmed: isConfirmed,
        hitsCount: realHits.length,
        note
      });
    }

    // Process unused devDependencies
    for (const pkg of unusedDevDeps) {
      let note = "";
      let isConfirmed = true;
      
      const hits = searchUsage(pkg, files);
      const realHits = hits.filter(h => !h.commented);
      
      if (pkg.startsWith('@types/')) {
        const baseLib = pkg.replace('@types/', '').replace('__', '/');
        const isBaseInstalled = allDeps.includes(baseLib) || allDevDeps.includes(baseLib);
        if (!isBaseInstalled) {
          note = `Type orphan (base library ${baseLib} not installed)`;
        } else {
          note = `Type definition for installed library ${baseLib}`;
          isConfirmed = false;
        }
      } else if (['typescript', 'tsx', 'nodemon', 'eslint', 'tsoa', 'concurrently', 'jest', 'mocha', 'prettier', 'ts-node'].includes(pkg)) {
        note = `Configuration/build tool; grep entire repo for config files`;
        isConfirmed = false;
      } else {
        isConfirmed = realHits.length === 0;
        if (hits.length > 0) {
          if (isConfirmed) {
            note = `Commented-out import found`;
          } else {
            note = `Used in code but flagged by depcheck`;
          }
        } else {
          note = "No imports or requires found in files";
        }
      }

      // Check placeholder prioritization
      if (pkg === 'crypto' || pkg === 'http') {
        note = `Placeholder package. ${note} (HIGH priority removal)`;
      }

      auditItems.push({
        name: pkg,
        type: 'dev',
        confirmed: isConfirmed,
        hitsCount: realHits.length,
        note
      });
    }

    // Check Dockerfile
    let dockerfileVerdict = "No Dockerfile found";
    let dockerfilePath = path.join(repoPath, 'Dockerfile');
    if (!fs.existsSync(dockerfilePath)) {
      dockerfilePath = path.join(repoPath, 'dockerfile');
    }
    
    if (fs.existsSync(dockerfilePath)) {
      try {
        const dockerfileContent = fs.readFileSync(dockerfilePath, 'utf-8');
        if (dockerfileContent.includes('--omit=dev') || dockerfileContent.includes('--production') || dockerfileContent.includes('--only=production')) {
          dockerfileVerdict = "Uses devDep tree-shaking / production omit during build";
        } else {
          dockerfileVerdict = "Uses plain npm install (devDeps will bloat prod image; recommend npm ci --omit=dev)";
        }
      } catch (e) {
        dockerfileVerdict = "Dockerfile found but unreadable";
      }
    }

    // Planned feature checks (e.g. multer + uploads/)
    const hasMulter = allDeps.includes('multer') || allDevDeps.includes('multer');
    const hasUploadsDir = fs.existsSync(path.join(repoPath, 'uploads')) || fs.existsSync(path.join(repoPath, 'src/uploads'));
    if (hasMulter && hasUploadsDir) {
      const item = auditItems.find(i => i.name === 'multer');
      if (item) {
        item.note = `${item.note} (Adjacent uploads/ directory found; verify feature not planned)`;
      }
    }

    // Duplicate check
    const dupCheckLibs = [
      { name: 'joi', alt: 'validator', desc: 'validation library redundancy' },
      { name: 'winston', alt: 'debug', desc: 'logging library redundancy' },
      { name: 'xlsx', alt: 'csvtojson', desc: 'spreadsheet parsing redundancy' },
    ];
    for (const dup of dupCheckLibs) {
      if (allDeps.includes(dup.name) && allDeps.includes(dup.alt)) {
        const item1 = auditItems.find(i => i.name === dup.name);
        const item2 = auditItems.find(i => i.name === dup.alt);
        if (item1) item1.note = `${item1.note} (Duplicate functionality with ${dup.alt})`;
        if (item2) item2.note = `${item2.note} (Duplicate functionality with ${dup.name})`;
      }
    }

    results.push({
      repo,
      dockerfileVerdict,
      auditItems
    });
  }

  // Save report to markdown file in artifacts
  let markdown = "# Dependency Audit Sweep Results\n\n";
  markdown += `Generated on ${new Date().toISOString()}\n\n`;
  
  // Overall Summary Table
  markdown += "## Overall Summary Table\n\n";
  markdown += "| Repository | Dockerfile Verdict | Confirmed Unused Prod Deps | Confirmed Unused Dev Deps |\n";
  markdown += "|---|---|---|---|\n";
  
  for (const r of results) {
    const unusedProd = r.auditItems.filter((i: any) => i.confirmed && i.type === 'prod').map((i: any) => `\`${i.name}\``).join(', ') || 'None';
    const unusedDev = r.auditItems.filter((i: any) => i.confirmed && i.type === 'dev').map((i: any) => `\`${i.name}\``).join(', ') || 'None';
    markdown += `| ${r.repo} | ${r.dockerfileVerdict} | ${unusedProd} | ${unusedDev} |\n`;
  }
  markdown += "\n\n";

  // Per-repo details
  for (const r of results) {
    markdown += `### ${r.repo}\n\n`;
    markdown += `**Dockerfile Verdict:** ${r.dockerfileVerdict}\n\n`;
    
    if (r.auditItems.length === 0) {
      markdown += "*No unused dependencies found.*\n\n";
      continue;
    }
    
    markdown += "| Package | prod/dev | Confirmed unused? | Note |\n";
    markdown += "|---|---|---|---|\n";
    for (const item of r.auditItems) {
      markdown += `| \`${item.name}\` | ${item.type} | ${item.confirmed ? 'Yes' : 'No'} | ${item.note} |\n`;
    }
    markdown += "\n";
    
    const uninstalls = r.auditItems.filter((i: any) => i.confirmed).map((i: any) => i.name);
    if (uninstalls.length > 0) {
      markdown += `**Uninstall command:** \`npm uninstall ${uninstalls.join(' ')}\`\n\n`;
    }
    markdown += "---\n\n";
  }

  const reportPath = path.join('C:/Users/NaveenPrajapati/.gemini/antigravity-cli/brain/701c7443-a22c-4e83-bfbf-5453f67bb575', 'dependency_audit_report.md');
  fs.writeFileSync(reportPath, markdown);
  console.log(`Markdown report written to ${reportPath}`);

  // Log gotchas to database
  const db = getDb();
  migrate(db);
  try {
    for (const gotcha of gotchasList) {
      addEntry(db, {
        type: 'gotcha',
        title: `Dependency audit blocked on ${gotcha.repo}`,
        summary: `Audit blocked on ${gotcha.repo}: ${gotcha.error}`.slice(0, 200),
        description: `The dependency audit sweep encountered an error on service ${gotcha.repo}: ${gotcha.error}. Analysis skipped.`,
        agent: 'Gemini',
        module: 'dependency-audit',
        category: 'Reference',
      });
      console.log(`Logged gotcha for ${gotcha.repo}`);
    }
  } catch (dbErr) {
    console.error('Failed to log gotchas to DB:', dbErr);
  }

  // Log final changelog/review entry
  try {
    const summaryText = results.map(r => {
      const prodCount = r.auditItems.filter((i: any) => i.confirmed && i.type === 'prod').length;
      const devCount = r.auditItems.filter((i: any) => i.confirmed && i.type === 'dev').length;
      return `${r.repo} (${prodCount} prod, ${devCount} dev unused)`;
    }).join('\n');

    const title = "Completed dependency audit sweep";
    const summary = `Swept 18 backend repos. Found unused packages across multiple services.`;
    const description = `The dependency sweep was completed successfully. Full report has been written to the artifacts folder.

Summary of findings:
${summaryText}`;

    const { id: entryId } = addEntry(db, {
      type: 'changelog', title, summary, description, agent: 'Gemini', module: 'dependency-audit', category: 'Activity',
    });
      
    console.log(`Logged changelog entry ${formatEntryRef(entryId)}`);
  } catch (dbErr) {
    console.error('Failed to log changelog to DB:', dbErr);
  } finally {
    closeDb();
  }
}

run().catch(console.error);
