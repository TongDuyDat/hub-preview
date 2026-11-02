(function () {
  const vscode = acquireVsCodeApi();
  const root = document.getElementById("root");
  let state = null;

  function send(command, payload) {
    vscode.postMessage(Object.assign({ command: command }, payload || {}));
  }

  function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }

  function svg(pathD, viewBox, size) {
    const s = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    const sDim = size || 16;
    s.setAttribute("viewBox", viewBox || "0 0 16 16");
    s.setAttribute("width", String(sDim));
    s.setAttribute("height", String(sDim));
    s.style.width = sDim + "px";
    s.style.height = sDim + "px";
    s.style.flexShrink = "0";
    const p = document.createElementNS("http://www.w3.org/2000/svg", "path");
    p.setAttribute("d", pathD);
    p.setAttribute("fill", "currentColor");
    p.setAttribute("fill-rule", "evenodd");
    s.appendChild(p);
    return s;
  }

  // Exact JetBrains Action Icons
  const ICONS = {
    // 1. MoveUp / MoveDown
    prev: "M8 12a.5.5 0 0 0 .5-.5V5.707l2.146 2.147a.5.5 0 0 0 .708-.708l-3-3a.5.5 0 0 0-.708 0l-3 3a.5.5 0 1 0 .708.708L7.5 5.707V11.5a.5.5 0 0 0 .5.5z",
    next: "M8 4a.5.5 0 0 1 .5.5v5.793l2.146-2.147a.5.5 0 0 1 .708.708l-3 3a.5.5 0 0 1-.708 0l-3-3a.5.5 0 1 1 .708-.708L7.5 10.293V4.5A.5.5 0 0 1 8 4z",

    // 2. Commit (-o-) & Rollback (↶)
    commit: "M0 8.5h4.5a3.5 3.5 0 0 0 7 0H16v-1h-4.5a3.5 3.5 0 0 0-7 0H0v1zm8-2a2 2 0 1 1 0 4 2 2 0 0 1 0-4z",
    rollback: "M9 3.5a5.5 5.5 0 0 0-5.5 5.5v1.293L1.646 8.44a.5.5 0 0 0-.708.708l2.5 2.5a.5.5 0 0 0 .708 0l2.5-2.5a.5.5 0 0 0-.708-.708L4.5 9.793V9A4.5 4.5 0 0 1 9 4.5h3.5a.5.5 0 0 0 0-1H9z",

    // 3. Checked (✓) & Cancel (✕)
    accept: "M13.854 3.646a.5.5 0 0 1 0 .708l-7 7a.5.5 0 0 1-.708 0l-3.5-3.5a.5.5 0 1 1 .708-.708L6.5 10.293l6.646-6.647a.5.5 0 0 1 .708 0z",
    reject: "M4.646 4.646a.5.5 0 0 1 .708 0L8 7.293l2.646-2.647a.5.5 0 0 1 .708.708L8.707 8l2.647 2.646a.5.5 0 0 1-.708.708L8 8.707l-2.646 2.647a.5.5 0 0 1-.708-.708L7.293 8 4.646 5.354a.5.5 0 0 1 0-.708z",

    // 4. Copy ([=]), Rules (≡), Gear (⚙)
    copy: "M4 2a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h1v-1H4a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1h6a1 1 0 0 1 1 1v1h1V4a2 2 0 0 0-2-2H4zm2 3a2 2 0 0 0-2 2v7a2 2 0 0 0 2 2h6a2 2 0 0 0 2-2V7a2 2 0 0 0-2-2H6zm0 1h6a1 1 0 0 1 1 1v7a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1z",
    rules: "M3 1.5A1.5 1.5 0 0 1 4.5 0h5.086a1.5 1.5 0 0 1 1.06.44l3.914 3.914a1.5 1.5 0 0 1 .44 1.06V14.5a1.5 1.5 0 0 1-1.5 1.5h-9A1.5 1.5 0 0 1 3 14.5v-13zM5 5.5a.5.5 0 0 0 0 1h4a.5.5 0 0 0 0-1H5zm0 3a.5.5 0 0 0 0 1h6a.5.5 0 0 0 0-1H5zm0 3a.5.5 0 0 0 0 1h6a.5.5 0 0 0 0-1H5z",
    gear: "M8 4.75a3.25 3.25 0 1 0 0 6.5 3.25 3.25 0 0 0 0-6.5zM9.05.5a1.5 1.5 0 0 0-2.1 0l-.35.35a1 1 0 0 1-1.2.2l-.46-.27a1.5 1.5 0 0 0-2.06.55l-.6 1.04a1.5 1.5 0 0 0 .4 2.1l.4.24a1 1 0 0 1 .47 1.13l-.1.5a1 1 0 0 1-.77.79l-.47.09a1.5 1.5 0 0 0-1.21 1.47v1.2a1.5 1.5 0 0 0 1.21 1.47l.47.09a1 1 0 0 1 .77.79l.1.5a1 1 0 0 1-.47 1.13l-.4.24a1.5 1.5 0 0 0-.4 2.1l.6 1.04a1.5 1.5 0 0 0 2.06.55l.46-.27a1 1 0 0 1 1.2.2l.35.35a1.5 1.5 0 0 0 2.1 0l.35-.35a1 1 0 0 1 1.2-.2l.46.27a1.5 1.5 0 0 0 2.06-.55l.6-1.04a1.5 1.5 0 0 0-.4-2.1l-.4-.24a1 1 0 0 1-.47-1.13l.1-.5a1 1 0 0 1 .77-.79l.47-.09a1.5 1.5 0 0 0 1.21-1.47v-1.2a1.5 1.5 0 0 0-1.21-1.47l-.47-.09a1 1 0 0 1-.77-.79l-.1-.5a1 1 0 0 1 .47-1.13l.4-.24a1.5 1.5 0 0 0 .4-2.1l-.6-1.04a1.5 1.5 0 0 0-2.06-.55l-.46.27a1 1 0 0 1-1.2-.2L9.05.5z",

    // 5. Web (🌐) & Refresh (↻)
    website: "M0 8a8 8 0 1 1 16 0A8 8 0 0 1 0 8zm7.5-6.923c-.67.204-1.335.82-1.887 1.855-.143.268-.276.56-.395.872.705.157 1.472.257 2.282.287V1.077zm-3.251 3.082c-.4.873-.655 1.879-.71 2.962h2.57c.045-.55.138-1.07.274-1.547-.709-.224-1.397-.733-2.134-1.415zM3.539 8.121c.055 1.083.31 2.089.71 2.962.737-.682 1.425-1.191 2.134-1.415-.136-.477-.229-.997-.274-1.547H3.539zm4.961 6.802c.67-.204 1.335-.82 1.887-1.855.143-.268.276-.56.395-.872-.705-.157-1.472-.257-2.282-.287v2.014zm1-3.003c.709.224 1.397.733 2.134 1.415.4-.873.655-1.879.71-2.962H9.774c-.045.55-.138 1.07-.274 1.547zm2.844-3.841c-.055-1.083-.31-2.089-.71-2.962-.737.682-1.425 1.191-2.134 1.415.136.477.229.997.274 1.547h2.57zM8.5 7.121v-2.01c-.81-.03-1.577-.13-2.282-.287.12-.312.252-.604.395-.872.552-1.035 1.218-1.65 1.887-1.855v5.024zm0 1.758v5.024c-.67-.204-1.335-.82-1.887-1.855-.143-.268-.276-.56-.395-.872.705-.157 1.472-.257 2.282-.287v-2.01z",
    refresh: "M11.534 7h3.932a.25.25 0 0 1 .192.41l-1.966 2.36a.25.25 0 0 1-.384 0l-1.966-2.36a.25.25 0 0 1 .192-.41zm-11 2h3.932a.25.25 0 0 0 .192-.41L2.692 6.23a.25.25 0 0 0-.384 0L.342 8.59A.25.25 0 0 0 .534 9zM8 3c-1.552 0-2.94.707-3.857 1.818a.5.5 0 1 1-.771-.636A6.002 6.002 0 0 1 13.917 7H12.9A5.002 5.002 0 0 0 8 3zM3.1 9a5.002 5.002 0 0 0 8.757 2.182.5.5 0 1 1 .771.636A6.002 6.002 0 0 1 2.083 9H3.1z",

    // File list icons
    file: "M4 1.5H11l3.5 3.5V14.5a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V2.5a1 1 0 0 1 1-1zm6.5 1V5H14L10.5 2.5z",
    diff: "M4 1.5H3a2 2 0 0 0-2 2V14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V3.5a2 2 0 0 0-2-2h-1v1h1a1 1 0 0 1 1 1V14a1 1 0 0 1-1 1H3a1 1 0 0 1-1-1V3.5a1 1 0 0 1 1-1h1v-1zM9.5 1a.5.5 0 0 1 .5.5v1a.5.5 0 0 1-.5.5h-3a.5.5 0 0 1-.5-.5v-1a.5.5 0 0 1 .5-.5h3z"
  };

  function toolButton(iconKey, title, className, onClick) {
    const btn = el("button", "tool-btn" + (className ? " " + className : ""));
    btn.title = title;
    btn.appendChild(svg(ICONS[iconKey], "0 0 16 16", 14));
    btn.addEventListener("click", function (e) {
      e.stopPropagation();
      onClick();
    });
    return btn;
  }

  function renderToolbar() {
    const bar = el("div", "jb-toolbar");

    // Group 1: Navigation
    const gNav = el("div", "tool-group");
    gNav.appendChild(toolButton("prev", "Previous Change (Alt+Up)", "", function () { send("prevHunk"); }));
    gNav.appendChild(toolButton("next", "Next Change (Alt+Down)", "", function () { send("nextHunk"); }));
    bar.appendChild(gNav);

    bar.appendChild(el("div", "tool-separator"));

    // Group 2: Checkpoint (-o- & ↶)
    const gCp = el("div", "tool-group");
    gCp.appendChild(toolButton("commit", "Set Checkpoint (Accept current disk state as baseline)", "", function () { send("setCheckpoint"); }));
    gCp.appendChild(toolButton("rollback", "Clear Checkpoint (Clear current checkpoint baseline)", "", function () { send("clearCheckpoint"); }));
    bar.appendChild(gCp);

    bar.appendChild(el("div", "tool-separator"));

    // Group 3: Decisions (✓ & ✕)
    const gDec = el("div", "tool-group");
    gDec.appendChild(toolButton("accept", "Accept All Changes", "accept-all", function () { send("acceptAll"); }));
    gDec.appendChild(toolButton("reject", "Reject All Changes", "reject-all", function () { send("rejectAll"); }));
    bar.appendChild(gDec);

    bar.appendChild(el("div", "tool-separator"));

    // Group 4: Rules & MCP ([=], ≡, ⚙)
    const gTools = el("div", "tool-group");
    gTools.appendChild(toolButton("copy", "Copy MCP Config (Claude Code, Cline, Roo Code)", "", function () { send("copyMcpConfig"); }));
    gTools.appendChild(toolButton("rules", "Copy AI Agent Rules (AGENTS.md, .cursorrules)", "", function () { send("copyAgentRules"); }));
    gTools.appendChild(toolButton("gear", "Register MCP in AI Tools", "", function () { send("registerMcp"); }));
    bar.appendChild(gTools);

    bar.appendChild(el("div", "tool-separator"));

    // Group 5: Web & Refresh (🌐 & ↻)
    const gSync = el("div", "tool-group");
    gSync.appendChild(toolButton("website", "Open Website & Docs", "", function () { send("openWebsite"); }));
    gSync.appendChild(toolButton("refresh", "Refresh Changes", "", function () { send("refresh"); }));
    bar.appendChild(gSync);

    return bar;
  }

  function renderFile(file) {
    const row = el("div", "file-row");
    row.title = file.dir ? file.dir + "/" + file.name : file.name;

    const iconDiv = el("div", "file-icon");
    iconDiv.appendChild(svg(file.isNew ? ICONS.commit : ICONS.file, "0 0 16 16", 14));
    row.appendChild(iconDiv);

    const info = el("div", "file-info");
    info.appendChild(el("span", "file-name", file.name));
    if (file.dir) {
      info.appendChild(el("span", "file-dir", file.dir));
    }
    row.appendChild(info);

    // Badges & Diff stats
    const badges = el("div", "file-badges");
    if (file.isNew) badges.appendChild(el("span", "badge ok", "NEW"));
    if (file.isDeleted) badges.appendChild(el("span", "badge no", "DEL"));
    if (file.isBinary) badges.appendChild(el("span", "badge bin", "BIN"));

    if (file.added || file.deleted) {
      const stats = el("span", "file-stats");
      if (file.added) stats.appendChild(el("span", "stat-add", "+" + file.added));
      if (file.deleted) stats.appendChild(el("span", "stat-del", "-" + file.deleted));
      badges.appendChild(stats);
    }
    row.appendChild(badges);

    // Quick hover actions: Accept file, Reject file
    const actions = el("div", "file-actions");
    const btnAccept = el("button", "file-act-btn accept");
    btnAccept.title = "Accept File";
    btnAccept.appendChild(svg(ICONS.accept, "0 0 16 16", 12));
    btnAccept.addEventListener("click", function (e) {
      e.stopPropagation();
      send("acceptFile", { changeId: file.id });
    });
    actions.appendChild(btnAccept);

    const btnReject = el("button", "file-act-btn reject");
    btnReject.title = "Reject File";
    btnReject.appendChild(svg(ICONS.reject, "0 0 16 16", 12));
    btnReject.addEventListener("click", function (e) {
      e.stopPropagation();
      send("rejectFile", { changeId: file.id });
    });
    actions.appendChild(btnReject);

    row.appendChild(actions);

    row.addEventListener("click", function () {
      send("openFile", { changeId: file.id });
    });
    return row;
  }

  function renderStatus(totalFiles, pendingCount) {
    const bar = el("div", "jb-statusbar");
    const isOk = totalFiles === 0;

    const icon = svg(isOk ? ICONS.accept : ICONS.diff, "0 0 16 16", 13);
    icon.setAttribute("class", isOk ? "status-icon status-ok" : "status-icon");
    bar.appendChild(icon);

    const countText = totalFiles === 0
      ? "Review Hub: Active (0 pending changes)"
      : `${totalFiles} file(s), ${pendingCount} pending`;

    bar.appendChild(el("span", "status-text", countText));
    return bar;
  }

  function render(next) {
    state = next;
    root.textContent = "";

    // 1. Top JetBrains Toolbar
    root.appendChild(renderToolbar());

    // 2. Center Content
    const content = el("div", "jb-content");

    if (next.totalFiles === 0) {
      const empty = el("div", "empty-container");
      empty.appendChild(el("div", "empty-title", "No pending changes"));
      empty.appendChild(el("div", "empty-desc", "Edits proposed by AI coding agents will appear here for review."));
      content.appendChild(empty);
    } else {
      const list = el("div", "file-list");
      for (const group of next.groups) {
        if (next.groups.length > 1) {
          list.appendChild(el("div", "group-header", group.label));
        }
        for (const file of group.files) {
          list.appendChild(renderFile(file));
        }
      }
      content.appendChild(list);
    }
    root.appendChild(content);

    // 3. Bottom Status Bar
    let pendingCount = 0;
    for (const g of next.groups || []) {
      for (const f of g.files || []) {
        pendingCount += (f.pending || 0);
      }
    }
    root.appendChild(renderStatus(next.totalFiles, pendingCount));
  }

  window.addEventListener("message", function (event) {
    const msg = event.data;
    if (msg && msg.type === "update") render(msg.state);
  });

  send("ready");
})();
