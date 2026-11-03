(function () {
  const vscode = acquireVsCodeApi();
  const root = document.getElementById("root");
  let state = null;
  let activeDropdown = null;

  function send(command, payload) {
    vscode.postMessage(Object.assign({ command: command }, payload || {}));
  }

  function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }

  // Official JetBrains Action Icons (extracted from IntelliJ Platform app-client.jar)
  const JB_ICONS = {
    // actions/checked.svg (ViewBox 0 0 12 12, crisp JetBrains check)
    accept: {
      viewBox: "0 0 12 12",
      d: "M5.279 11 L4.898 11 L1.013 4.398 L2.486 3.548 L5.241 8.320 L9.513 0.92 L10.986 1.77 L5.651 11 L5.279 11 Z"
    },
    // actions/cancel.svg (ViewBox 0 0 16 16, crisp JetBrains cancel)
    reject: {
      viewBox: "0 0 16 16",
      d: "M8 9.414L4.207 13.207L2.793 11.793L6.586 8L2.793 4.207L4.207 2.793L8 6.586L11.793 2.793L13.207 4.207L9.414 8L13.207 11.793L11.793 13.207L8 9.414Z"
    },
    // vcs/commitNode.svg rotated 90deg (ViewBox 0 0 16 16, line with circle)
    commit: {
      viewBox: "0 0 16 16",
      d: "M7 11.874C5.275 11.43 4 9.864 4 8C4 6.136 5.275 4.57 7 4.126L7 1L9 1L9 4.126C10.725 4.57 12 6.136 12 8C12 9.864 10.725 11.43 9 11.874L9 15L7 15L7 11.874ZM8 10C9.105 10 10 9.105 10 8C10 6.895 9.105 6 8 6C6.895 6 6 6.895 6 8C6 9.105 6.895 10 8 10Z",
      transform: "rotate(90 8 8)"
    },
    // actions/rollback.svg (ViewBox 0 0 16 16, curved rollback arrow)
    rollback: {
      viewBox: "0 0 16 16",
      rollback: true,
      d: "M4 11L8 11C9.657 11 11 9.657 11 8C11 6.343 9.657 5 8 5L4 5L4 3L8 3C10.761 3 13 5.239 13 8C13 10.761 10.761 13 8 13L4 13L4 11Z",
      poly: "0 .1 4 4.1 0 8.1",
      groupTransform: "translate(2 1)"
    },
    // actions/refresh.svg (ViewBox 0 0 16 16, crisp JetBrains circular refresh)
    refresh: {
      viewBox: "0 0 16 16",
      d: "M12.575 11.885C11.474 13.182 9.832 14.004 8 14.004C5.039 14.004 2.58 11.862 2.088 9.043L3.948 9.108C4.434 10.89 6.064 12.2 8 12.2C9.301 12.2 10.465 11.608 11.235 10.679L9.05 8.712L14.043 8.45L14.305 13.443L12.575 11.885ZM3.428 4.117C4.528 2.825 6.168 2.004 8 2.004C10.919 2.004 13.351 4.09 13.888 6.853L12.023 6.788C11.502 5.059 9.898 3.8 8 3.8C6.699 3.8 5.535 4.392 4.765 5.321L6.955 7.293L1.962 7.555L1.7 2.562L3.428 4.117Z",
      transform: "rotate(3 8 8)"
    },
    // expui/general/moreVertical_dark.svg (3 clean vertical dots)
    more: {
      viewBox: "0 0 16 16",
      dots: [[8, 3], [8, 8], [8, 13]]
    },
    // File icon
    file: {
      viewBox: "0 0 16 16",
      d: "M4 1.5H11l3.5 3.5V14.5a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V2.5a1 1 0 0 1 1-1zm6.5 1V5H14L10.5 2.5z"
    },
    // Diff icon
    diff: {
      viewBox: "0 0 16 16",
      d: "M4 1.5H3a2 2 0 0 0-2 2V14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V3.5a2 2 0 0 0-2-2h-1v1h1a1 1 0 0 1 1 1V14a1 1 0 0 1-1 1H3a1 1 0 0 1-1-1V3.5a1 1 0 0 1 1-1h1v-1zM9.5 1a.5.5 0 0 1 .5.5v1a.5.5 0 0 1-.5.5h-3a.5.5 0 0 1-.5-.5v-1a.5.5 0 0 1 .5-.5h3z"
    }
  };

  function svgIcon(key, size) {
    const sDim = size || 16;
    const def = JB_ICONS[key];
    const s = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    s.setAttribute("viewBox", def ? def.viewBox : "0 0 16 16");
    s.setAttribute("width", String(sDim));
    s.setAttribute("height", String(sDim));
    s.style.width = sDim + "px";
    s.style.height = sDim + "px";
    s.style.minWidth = sDim + "px";
    s.style.minHeight = sDim + "px";
    s.style.maxWidth = sDim + "px";
    s.style.maxHeight = sDim + "px";
    s.style.flexShrink = "0";

    if (!def) return s;

    if (def.dots) {
      for (const pt of def.dots) {
        const c = document.createElementNS("http://www.w3.org/2000/svg", "circle");
        c.setAttribute("cx", String(pt[0]));
        c.setAttribute("cy", String(pt[1]));
        c.setAttribute("r", "1.3");
        c.setAttribute("fill", "currentColor");
        s.appendChild(c);
      }
    } else if (def.rollback) {
      const g = document.createElementNS("http://www.w3.org/2000/svg", "g");
      g.setAttribute("fill", "currentColor");
      g.setAttribute("fill-rule", "evenodd");
      if (def.groupTransform) g.setAttribute("transform", def.groupTransform);
      const poly = document.createElementNS("http://www.w3.org/2000/svg", "polygon");
      poly.setAttribute("points", def.poly);
      poly.setAttribute("transform", "matrix(-1 0 0 1 4 0)");
      g.appendChild(poly);
      const p = document.createElementNS("http://www.w3.org/2000/svg", "path");
      p.setAttribute("d", def.d);
      g.appendChild(p);
      s.appendChild(g);
    } else {
      const p = document.createElementNS("http://www.w3.org/2000/svg", "path");
      p.setAttribute("d", def.d);
      p.setAttribute("fill", "currentColor");
      p.setAttribute("fill-rule", "evenodd");
      if (def.transform) p.setAttribute("transform", def.transform);
      s.appendChild(p);
    }
    return s;
  }

  function toolButton(iconKey, title, className, onClick) {
    const btn = el("button", "tool-btn" + (className ? " " + className : ""));
    btn.title = title;
    btn.appendChild(svgIcon(iconKey, 14));
    btn.addEventListener("click", function (e) {
      e.stopPropagation();
      onClick(e);
    });
    return btn;
  }

  function closeMenu() {
    if (activeDropdown && activeDropdown.parentNode) {
      activeDropdown.parentNode.removeChild(activeDropdown);
      activeDropdown = null;
    }
  }

  function toggleMenu(container) {
    if (activeDropdown) {
      closeMenu();
      return;
    }
    const menu = el("div", "jb-dropdown-menu");
    const items = [
      { label: "Copy MCP Config", title: "Copy JSON configuration for AI Tools", cmd: "copyMcpConfig" },
      { label: "Copy AI Agent Rules", title: "Copy instruction rules for AI Tools", cmd: "copyAgentRules" },
      { label: "Register MCP in AI Tools", title: "Auto-register MCP into Claude Code, Cline, Roo Code", cmd: "registerMcp" },
      { sep: true },
      { label: "Open Website & Docs", title: "Open Review Hub documentation", cmd: "openWebsite" },
      { label: "Hub Info & Status", title: "View port, token and server status", cmd: "showHubInfo" }
    ];

    for (const it of items) {
      if (it.sep) {
        menu.appendChild(el("div", "jb-menu-separator"));
      } else {
        const itemEl = el("div", "jb-menu-item", it.label);
        itemEl.title = it.title;
        itemEl.addEventListener("click", function (e) {
          e.stopPropagation();
          closeMenu();
          send(it.cmd);
        });
        menu.appendChild(itemEl);
      }
    }
    container.appendChild(menu);
    activeDropdown = menu;
  }

  document.addEventListener("click", function () {
    closeMenu();
  });

  function renderToolbar() {
    const bar = el("div", "jb-toolbar");

    // Group 1: Review Decisions (✓ & ✕)
    const gDec = el("div", "tool-group");
    gDec.appendChild(toolButton("accept", "Accept All Changes", "accept-all", function () { send("acceptAll"); }));
    gDec.appendChild(toolButton("reject", "Reject All Changes", "reject-all", function () { send("rejectAll"); }));
    bar.appendChild(gDec);

    bar.appendChild(el("div", "tool-separator"));

    // Group 2: Checkpoint (-o- & ↶)
    const gCp = el("div", "tool-group");
    gCp.appendChild(toolButton("commit", "Set Checkpoint", "", function () { send("setCheckpoint"); }));
    gCp.appendChild(toolButton("rollback", "Clear Checkpoint", "", function () { send("clearCheckpoint"); }));
    bar.appendChild(gCp);

    bar.appendChild(el("div", "tool-separator"));

    // Group 3: Refresh (↻)
    const gSync = el("div", "tool-group");
    gSync.appendChild(toolButton("refresh", "Refresh Changes", "", function () { send("refresh"); }));
    bar.appendChild(gSync);

    bar.appendChild(el("div", "spacer"));

    // Group 4: In-place Dropdown Menu (⋮) - Exactly matching JetBrains!
    const dropdownWrap = el("div", "jb-dropdown-container");
    const moreBtn = toolButton("more", "More Options", "more-btn", function () {
      toggleMenu(dropdownWrap);
    });
    dropdownWrap.appendChild(moreBtn);
    bar.appendChild(dropdownWrap);

    return bar;
  }

  function renderFile(file) {
    const row = el("div", "file-row");
    row.title = file.dir ? file.dir + "/" + file.name : file.name;

    const iconDiv = el("div", "file-icon");
    iconDiv.appendChild(svgIcon(file.isNew ? "commit" : "file", 14));
    row.appendChild(iconDiv);

    const info = el("div", "file-info");
    info.appendChild(el("span", "file-name", file.name));
    if (file.dir) {
      info.appendChild(el("span", "file-dir", file.dir));
    }
    row.appendChild(info);

    // Badges & Diff stats
    const meta = el("div", "file-meta");
    if (file.isNew) {
      meta.appendChild(el("span", "file-badge badge-new", "NEW"));
    } else if (file.isDeleted) {
      meta.appendChild(el("span", "file-badge badge-del", "DEL"));
    }

    if (file.added > 0) {
      meta.appendChild(el("span", "diff-stat stat-add", "+" + file.added));
    }
    if (file.removed > 0) {
      meta.appendChild(el("span", "diff-stat stat-rem", "-" + file.removed));
    }
    row.appendChild(meta);

    // Hover quick action buttons
    const actions = el("div", "file-actions");
    const btnAccept = el("button", "file-act-btn act-accept");
    btnAccept.title = "Accept File";
    btnAccept.appendChild(svgIcon("accept", 12));
    btnAccept.addEventListener("click", function (e) {
      e.stopPropagation();
      send("acceptFile", { changeId: file.id });
    });
    actions.appendChild(btnAccept);

    const btnReject = el("button", "file-act-btn act-reject");
    btnReject.title = "Reject File";
    btnReject.appendChild(svgIcon("reject", 12));
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

    const icon = svgIcon(isOk ? "accept" : "diff", 13);
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
