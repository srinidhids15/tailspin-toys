import { createServer } from "node:http";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { CanvasError, createCanvas, joinSession } from "@github/copilot-sdk/extension";

const execFileAsync = promisify(execFile);
const servers = new Map();

async function loadIssues(cwd) {
    const { stdout } = await execFileAsync("gh", [
        "issue", "list", "--state", "open", "--limit", "100",
        "--json", "number,title,body,createdAt,updatedAt,url",
    ], { cwd, maxBuffer: 1024 * 1024 });
    return JSON.parse(stdout);
}

function describeIssue(issue) {
    const text = issue.body?.replace(/\s+/g, " ").trim() || "No description provided.";
    const summary = text.split(/ acceptance criteria |## /i)[0].trim();
    return summary.length > 240 ? `${summary.slice(0, 237)}...` : summary;
}

function rankIssue(issue) {
    const body = issue.body || "";
    const criteriaCount = (body.match(/^- \[[ x]\]/gim) || []).length;
    const title = issue.title.toLowerCase();
    const signals = [];
    let score = criteriaCount * 2 + Math.min(body.length / 500, 4);

    if (title.includes("assistant")) {
        score += 8;
        signals.push("largest cross-cutting feature");
    }
    if (title.includes("filter") || title.includes("search") || title.includes("sort")) {
        score += 5;
        signals.push("high-leverage catalog discovery work");
    }
    if (title.includes("filter")) signals.push("supports combined browsing workflows");
    if (title.includes("search")) signals.push("foundational narrowing workflow");
    if (criteriaCount >= 5) signals.push(`${criteriaCount} acceptance criteria need tracking`);
    if (signals.length === 0) signals.push("clear, bounded catalog improvement");

    return { ...issue, description: describeIssue(issue), score, signals };
}

function rankIssues(issues) {
    return issues.map(rankIssue).sort((a, b) => b.score - a.score || a.number - b.number);
}

function escapeHtml(value) {
    return String(value)
        .replaceAll("&", "&amp;")
        .replaceAll("<", "&lt;")
        .replaceAll(">", "&gt;")
        .replaceAll('"', "&quot;")
        .replaceAll("'", "&#039;");
}

function renderCard(issue, priority) {
    const reason = priority
        ? `<p class="reason"><strong>Why now:</strong> ${escapeHtml(`Top priority because it is ${issue.signals.join(" and ")}.`)}</p>`
        : "";
    return `<article class="card${priority ? " priority" : ""}">
      <div class="card-header"><span class="number">#${issue.number}</span><span class="status">Open</span></div>
      <h3>${escapeHtml(issue.title)}</h3>
      <p>${escapeHtml(issue.description)}</p>
      ${reason}
      <div class="card-footer">
        <a href="${escapeHtml(issue.url)}" target="_blank" rel="noreferrer">View issue</a>
        <button type="button" data-issue="${issue.number}">Add to current context</button>
      </div>
    </article>`;
}

function renderHtml(issues, error) {
    const ranked = rankIssues(issues);
    const priority = ranked.slice(0, 3);
    const remainder = ranked.slice(3);
    return `<!doctype html>
<html>
  <head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Issue triage board</title>
    <style>
      body { margin: 0; padding: 24px; background: var(--background-color-default, #fff); color: var(--text-color-default, #1f2328); font: 14px/1.45 var(--font-sans, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif); }
      h1 { margin: 0 0 4px; font-size: 24px; } h2 { margin: 28px 0 12px; font-size: 16px; } h3 { margin: 10px 0 8px; font-size: 16px; }
      .intro { color: var(--text-color-muted, #656d76); margin: 0 0 20px; } .board { display: grid; gap: 12px; grid-template-columns: repeat(auto-fit, minmax(240px, 1fr)); }
      .card { border: 1px solid var(--border-color-default, #d0d7de); border-radius: 8px; padding: 16px; } .priority { border-color: var(--true-color-blue, #0969da); box-shadow: 0 0 0 1px var(--true-color-blue, #0969da); }
      .card-header, .card-footer { display: flex; align-items: center; justify-content: space-between; gap: 8px; } .number { color: var(--text-color-muted, #656d76); font-weight: 600; } .status { color: var(--true-color-green, #1a7f37); font-size: 12px; }
      .card p { margin: 0 0 14px; } .reason { padding: 10px; border-radius: 6px; background: var(--background-color-muted, #f6f8fa); }
      a { color: var(--true-color-blue, #0969da); } button { border: 1px solid var(--border-color-default, #d0d7de); border-radius: 6px; padding: 7px 10px; background: var(--background-color-muted, #f6f8fa); color: inherit; cursor: pointer; font: inherit; }
      button:hover { border-color: var(--true-color-blue, #0969da); } button:focus-visible, a:focus-visible { outline: 2px solid var(--color-focus-outline, #0969da); outline-offset: 2px; }
      .error { padding: 12px; border: 1px solid var(--true-color-red, #cf222e); border-radius: 6px; } .empty { color: var(--text-color-muted, #656d76); }
    </style>
  </head>
  <body><main>
    <h1>Issue triage board</h1>
    <p class="intro">Open issues ranked by scope, leverage, and acceptance-criteria complexity.</p>
    ${error ? `<div class="error" role="alert">${escapeHtml(error)}</div>` : ""}
    <h2>Most likely to need attention now</h2>
    <section class="board" aria-label="Priority issues">${priority.length ? priority.map((issue) => renderCard(issue, true)).join("") : '<p class="empty">No open issues found.</p>'}</section>
    <h2>Remaining open issues</h2>
    <section class="board" aria-label="Remaining issues">${remainder.length ? remainder.map((issue) => renderCard(issue, false)).join("") : '<p class="empty">No remaining issues.</p>'}</section>
    <p id="feedback" role="status" aria-live="polite"></p>
  </main>
  <script>
    document.querySelectorAll("button[data-issue]").forEach((button) => {
      button.addEventListener("click", async () => {
        const feedback = document.querySelector("#feedback");
        button.disabled = true;
        feedback.textContent = "Adding issue to the current context...";
        try {
          const response = await fetch("/context", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ issueNumber: Number(button.dataset.issue) }) });
          const result = await response.json();
          if (!response.ok) throw new Error(result.error || "Unable to add issue.");
          feedback.textContent = result.message;
          button.textContent = "Added to context";
        } catch (error) {
          feedback.textContent = error.message;
          button.disabled = false;
        }
      });
    });
  </script>
</html>`;
}

async function startServer(instanceId, cwd) {
    let issues = [];
    let error = "";
    try {
        issues = await loadIssues(cwd);
    } catch (cause) {
        error = `Could not load open issues: ${cause instanceof Error ? cause.message : String(cause)}`;
    }

    const server = createServer((req, res) => {
        if (req.method === "POST" && req.url === "/context") {
            let body = "";
            req.on("data", (chunk) => { body += chunk; });
            req.on("end", async () => {
                try {
                    const input = JSON.parse(body);
                    const issue = issues.find((candidate) => candidate.number === input.issueNumber);
                    if (!issue) throw new CanvasError("issue_not_found", "That issue is no longer open.");
                    await session.send({ prompt: `Add GitHub issue #${issue.number} to the current context and start working on it. Title: ${issue.title}. Description: ${describeIssue(issue)}. URL: ${issue.url}` });
                    res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
                    res.end(JSON.stringify({ message: `Issue #${issue.number} added to the current context.` }));
                } catch (cause) {
                    res.writeHead(400, { "Content-Type": "application/json; charset=utf-8" });
                    res.end(JSON.stringify({ error: cause instanceof Error ? cause.message : String(cause) }));
                }
            });
            return;
        }
        res.setHeader("Content-Type", "text/html; charset=utf-8");
        res.end(renderHtml(issues, error));
    });
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    const port = typeof address === "object" && address ? address.port : 0;
    return { server, url: `http://127.0.0.1:${port}/`, issues };
}

const session = await joinSession({
    canvases: [createCanvas({
        id: "kanban-triage-board",
        displayName: "Issue triage board",
        description: "Kanban board for prioritizing open GitHub issues and adding one to the current session context.",
        actions: [{
            name: "add_issue_to_context",
            description: "Add an open issue from this board to the current session context.",
            inputSchema: { type: "object", properties: { issueNumber: { type: "integer" } }, required: ["issueNumber"], additionalProperties: false },
            handler: async (ctx) => {
                const entry = servers.get(ctx.instanceId);
                const issue = entry?.issues.find((candidate) => candidate.number === ctx.input.issueNumber);
                if (!issue) throw new CanvasError("issue_not_found", "That issue is not available on this board.");
                await session.send({ prompt: `Add GitHub issue #${issue.number} to the current context and start working on it. Title: ${issue.title}. Description: ${describeIssue(issue)}. URL: ${issue.url}` });
                return { message: `Issue #${issue.number} added to the current context.` };
            },
        }],
        open: async (ctx) => {
            let entry = servers.get(ctx.instanceId);
            if (!entry) {
                entry = await startServer(ctx.instanceId, process.cwd());
                servers.set(ctx.instanceId, entry);
            }
            return { title: "Issue triage board", url: entry.url };
        },
        onClose: async (ctx) => {
            const entry = servers.get(ctx.instanceId);
            if (entry) {
                servers.delete(ctx.instanceId);
                await new Promise((resolve) => entry.server.close(() => resolve()));
            }
        },
    })],
});
