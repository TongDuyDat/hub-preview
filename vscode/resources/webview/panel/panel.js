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

  function svg(pathD, viewBox) {
    const s = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    s.setAttribute("viewBox", viewBox || "0 0 16 16");
    const p = document.createElementNS("http://www.w3.org/2000/svg", "path");
    p.setAttribute("d", pathD);
    p.setAttribute("fill-rule", "evenodd");
    s.appendChild(p);
    return s;
  }

  const ICONS = {
    prev: "M8 12a.5.5 0 0 0 .5-.5V5.707l2.146 2.147a.5.5 0 0 0 .708-.708l-3-3a.5.5 0 0 0-.708 0l-3 3a.5.5 0 1 0 .708.708L7.5 5.707V11.5a.5.5 0 0 0 .5.5z",
    next: "M8 4a.5.5 0 0 1 .5.5v5.793l2.146-2.147a.5.5 0 0 1 .708.708l-3 3a.5.5 0 0 1-.708 0l-3-3a.5.5 0 1 1 .708-.708L7.5 10.293V4.5A.5.5 0 0 1 8 4z",
    accept: "M13.854 3.646a.5.5 0 0 1 0 .708l-7 7a.5.5 0 0 1-.708 0l-3.5-3.5a.5.5 0 1 1 .708-.708L6.5 10.293l6.646-6.647a.5.5 0 0 1 .708 0z",
    reject: "M4.646 4.646a.5.5 0 0 1 .708 0L8 7.293l2.646-2.647a.5.5 0 0 1 .708.708L8.707 8l2.647 2.646a.5.5 0 0 1-.708.708L8 8.707l-2.646 2.647a.5.5 0 0 1-.708-.708L7.293 8 4.646 5.354a.5.5 0 0 1 0-.708z",
    checkpoint: "M8 3a5 5 0 1 0 4.546 2.914.5.5 0 0 1 .908-.417A6 6 0 1 1 8 2v1zm.41-2.466a.25.25 0 0 0-.41.192v3.932a.25.25 0 0 0 .41.192l2.36-1.966a.25.25 0 0 0 0-.384L8.41.534z",
    refresh: "M11.534 7h3.932a.25.25 0 0 1 .192.41l-1.966 2.36a.25.25 0 0 1-.384 0l-1.966-2.36a.25.25 0 0 1 .192-.41zm-11 2h3.932a.25.25 0 0 0 .192-.41L2.692 6.23a.25.25 0 0 0-.384 0L.342 8.59A.25.25 0 0 0 .534 9zM8 3c-1.552 0-2.94.707-3.857 1.818a.5.5 0 1 1-.771-.636A6.002 6.002 0 0 1 13.917 7H12.9A5.002 5.002 0 0 0 8 3zM3.1 9a5.002 5.002 0 0 0 8.757 2.182.5.5 0 1 1 .771.636A6.002 6.002 0 0 1 2.083 9H3.1z",
    diff: "M4 1.5H3a2 2 0 0 0-2 2V14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V3.5a2 2 0 0 0-2-2h-1v1h1a1 1 0 0 1 1 1V14a1 1 0 0 1-1 1H3a1 1 0 0 1-1-1V3.5a1 1 0 0 1 1-1h1v-1zM9.5 1a.5.5 0 0 1 .5.5v1a.5.5 0 0 1-.5.5h-3a.5.5 0 0 1-.5-.5v-1a.5.5 0 0 1 .5-.5h3z",
    website: "M0 8a8 8 0 1 1 16 0A8 8 0 0 1 0 8zm7.5-6.923c-.67.204-1.335.82-1.887 1.855-.143.268-.276.56-.395.872.705.157 1.472.257 2.282.287V1.077zm-3.251 3.082c-.4.873-.655 1.879-.71 2.962h2.57c.045-.55.138-1.07.274-1.547-.709-.224-1.397-.733-2.134-1.415zM3.539 8.121c.055 1.083.31 2.089.71 2.962.737-.682 1.425-1.191 2.134-1.415-.136-.477-.229-.997-.274-1.547H3.539zm4.961 6.802c.67-.204 1.335-.82 1.887-1.855.143-.268.276-.56.395-.872-.705-.157-1.472-.257-2.282-.287v2.014zm1-3.003c.709.224 1.397.733 2.134 1.415.4-.873.655-1.879.71-2.962H9.774c-.045.55-.138 1.07-.274 1.547zm2.844-3.841c-.055-1.083-.31-2.089-.71-2.962-.737.682-1.425 1.191-2.134 1.415.136.477.229.997.274 1.547h2.57zM8.5 7.121v-2.01c-.81-.03-1.577-.13-2.282-.287.12-.312.252-.604.395-.872.552-1.035 1.218-1.65 1.887-1.855v5.024zm0 1.758v5.024c-.67-.204-1.335-.82-1.887-1.855-.143-.268-.276-.56-.395-.872.705-.157 1.472-.257 2.282-.287v-2.01z",
    rules: "M14 4.5V14a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V2a2 2 0 0 1 2-2h5.5L14 4.5zm-3 0A1.5 1.5 0 0 1 9.5 3V1H4a1 1 0 0 0-1 1v12a1 1 0 0 0 1 1h8a1 1 0 0 0 1-1V4.5h-2z",
    file: "M4 1.5H11l3.5 3.5V14.5a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V2.5a1 1 0 0 1 1-1zm6.5 1V5H14L10.5 2.5z",
    commit: "M10.5 8a2.5 2.5 0 1 1-5 0 2.5 2.5 0 0 1 5 0zm1.455.5A3.501 3.501 0 0 0 8 4.5a3.501 3.501 0 0 0-3.955 4H1.5a.5.5 0 0 0 0 1h2.545a3.501 3.501 0 0 0 7.91 0h2.545a.5.5 0 0 0 0-1h-2.545z"
  };

  function toolButton(iconKey, title, className, onClick) {
    const btn = el("button", "tool-btn" + (className ? " " + className : ""));
    btn.title = title;
    btn.appendChild(svg(ICONS[iconKey]));
    btn.addEventListener("click", function (e) {
      e.stopPropagation();
      onClick();
    });
    return btn;
  }

  function renderToolbar() {
    const bar = el("div", "jb-toolbar");

    const gNav = el("div", "tool-group");
    gNav.appendChild(toolButton("prev", "Previous Change (Alt+[)", "", function () { send("prevHunk"); }));
    gNav.appendChild(toolButton("next", "Next Change (Alt+])", "", function () { send("nextHunk"); }));
    bar.appendChild(gNav);

    bar.appendChild(el("div", "tool-separator"));

    const gDec = el("div", "tool-group");
    gDec.appendChild(toolButton("accept", "Accept All Changes", "accept-all", function () { send("acceptAll"); }));
    gDec.appendChild(toolButton("reject", "Reject All Changes", "reject-all", function () { send("rejectAll"); }));
    bar.appendChild(gDec);

    bar.appendChild(el("div", "tool-separator"));

    const gSync = el("div", "tool-group");
    gSync.appendChild(toolButton("checkpoint", "Set Checkpoint (Accept current state)", "", function () { send("setCheckpoint"); }));
    gSync.appendChild(toolButton("refresh", "Refresh Changes", "", function () { send("refresh"); }));
    bar.appendChild(gSync);

    bar.appendChild(el("div", "spacer"));

    const gExt = el("div", "tool-group");
    gExt.appendChild(toolButton("rules", "Copy AI Agent Rules", "", function () { send("copyAgentRules"); }));
    gExt.appendChild(toolButton("website", "Open Review Hub Website", "", function () { send("openWebsite"); }));
    bar.appendChild(gExt);

    return bar;
  }

  function renderFile(file) {
    const row = el("div", "file-row");
    row.title = file.dir ? file.dir + "/" + file.name : file.name;

    const iconDiv = el("div", "file-icon");
    iconDiv.appendChild(svg(file.isNew ? ICONS.commit : ICONS.file));
    row.appendChild(iconDiv);

    const info = el("div", "file-info");
    info.appendChild(el("span", "file-name", file.name));
    if (file.dir) {
      info.appendChild(el("span", "file-dir", file.dir));
    }
    row.appendChild(info);

    if (file.isNew || file.isDeleted || file.binary) {
      const badges = el("div", "file-badges");
      if (file.isNew) badges.appendChild(el("span", "badge ok", "new"));
      if (file.isDeleted) badges.appendChild(el("span", "badge no", "deleted"));
      if (file.binary) badges.appendChild(el("span", "badge bin", "bin"));
      row.appendChild(badges);
    }

    if (file.added > 0 || file.removed > 0) {
      const stats = el("div", "file-stats");
      if (file.added > 0) stats.appendChild(el("span", "stat-add", "+" + file.added));
      if (file.removed > 0) stats.appendChild(el("span", "stat-del", "\u2212" + file.removed));
      row.appendChild(stats);
    }

    const actions = el("div", "file-actions");
    const btnAccept = el("button", "file-act-btn accept");
    btnAccept.title = "Accept File";
    btnAccept.appendChild(svg(ICONS.accept));
    btnAccept.addEventListener("click", function (e) {
      e.stopPropagation();
      send("acceptFile", { changeId: file.id });
    });
    actions.appendChild(btnAccept);

    const btnReject = el("button", "file-act-btn reject");
    btnReject.title = "Reject File";
    btnReject.appendChild(svg(ICONS.reject));
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
    const icon = svg(ICONS.accept);
    icon.className = "status-icon";
    bar.appendChild(icon);

    const countText = totalFiles === 0
      ? "Review Hub: Active (0 pending changes)"
      : `Review Hub: Active (${totalFiles} file${totalFiles === 1 ? "" : "s"} to review)`;

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

      if (next.checkpoint && next.checkpoint.files > 0) {
        empty.appendChild(el("div", "empty-checkpoint", `Checkpoint: ${next.checkpoint.files} files`));
      }
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
