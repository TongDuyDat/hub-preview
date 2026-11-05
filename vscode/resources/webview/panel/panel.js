(function () {
  const vscode = acquireVsCodeApi();
  const root = document.getElementById("root");
  const saved = vscode.getState() || {};
  const expanded = new Set(Array.isArray(saved.expanded) ? saved.expanded : []);
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

  const paths = {
    check: "m4 8 2.5 2.5L12 5",
    close: "m5 5 6 6m0-6-6 6",
    chevron: "m6 4 4 4-4 4",
    file: "M9 2H4v12h8V5L9 2Zm0 0v3h3",
    undo: "M3 7h6a4 4 0 0 1 0 8M3 7l3-3M3 7l3 3",
    open: "M6 3H3v10h10v-3M9 2h5v5M14 2 7 9",
    code: "m5 4-4 4 4 4m6-8 4 4-4 4M9 3 7 13",
    layers: "m8 2 6 3-6 3-6-3 6-3ZM2 8l6 3 6-3M2 11l6 3 6-3",
  };
  function icon(name) {
    const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    svg.setAttribute("viewBox", "0 0 16 16");
    svg.setAttribute("fill", "none");
    svg.setAttribute("stroke", "currentColor");
    svg.setAttribute("stroke-width", "1.4");
    svg.setAttribute("stroke-linecap", "round");
    svg.setAttribute("stroke-linejoin", "round");
    svg.setAttribute("aria-hidden", "true");
    svg.classList.add("icon");
    const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
    path.setAttribute("d", paths[name]);
    svg.appendChild(path);
    return svg;
  }

  function button(label, title, onClick, kind, iconName, key) {
    const b = el("button", "btn " + (kind || "secondary"));
    b.type = "button";
    b.title = title;
    b.setAttribute("aria-label", title);
    if (key) b.dataset.focusKey = key;
    if (iconName) b.appendChild(icon(iconName));
    if (label) b.appendChild(el("span", "", label));
    b.addEventListener("click", function (e) {
      e.stopPropagation();
      onClick();
    });
    return b;
  }

  function stats(added, removed) {
    const group = el("span", "stats");
    group.setAttribute("aria-label", added + " lines added, " + removed + " lines removed");
    group.appendChild(el("span", "stat add", "+" + added));
    group.appendChild(el("span", "stat del", "−" + removed));
    return group;
  }

  function toggleFile(file, force) {
    const open = force === undefined ? !expanded.has(file.id) : force;
    if (open) expanded.add(file.id);
    else expanded.delete(file.id);
    vscode.setState({ expanded: Array.from(expanded) });
    render(state);
  }

  function treeKeys(event, file, hunk) {
    const key = event.key;
    if (!["ArrowDown", "ArrowUp", "ArrowRight", "ArrowLeft", "Home", "End"].includes(key)) return;
    event.preventDefault();
    const nodes = Array.from(root.querySelectorAll("[data-tree-node]")).filter(function (node) { return node.getClientRects().length > 0; });
    const index = nodes.indexOf(event.currentTarget);
    let target;
    if (key === "ArrowDown") target = nodes[Math.min(index + 1, nodes.length - 1)];
    if (key === "ArrowUp") target = nodes[Math.max(index - 1, 0)];
    if (key === "Home") target = nodes[0];
    if (key === "End") target = nodes[nodes.length - 1];
    if (key === "ArrowRight" && !hunk) {
      if (!expanded.has(file.id)) { toggleFile(file, true); return; }
      target = nodes[index + 1];
    }
    if (key === "ArrowLeft") {
      if (!hunk && expanded.has(file.id)) { toggleFile(file, false); return; }
      if (hunk) target = Array.from(root.querySelectorAll("[data-tree-node]")).find(function (node) { return node.dataset.focusKey === file.id + "-toggle"; });
    }
    if (target) target.focus();
  }

  function renderHunk(file, hunk, index) {
    const row = el("li", "hunk hunk-" + hunk.decision);
    const open = button("", "Review block " + (index + 1) + " at line " + hunk.anchorLine,
      function () { send("openHunk", { changeId: file.id, hunkId: hunk.id }); }, "tree-label hunk-link", null, hunk.id + "-open");
    open.dataset.treeNode = "true";
    open.addEventListener("keydown", function (event) { treeKeys(event, file, hunk); });
    open.appendChild(icon("code"));
    open.appendChild(el("span", "block-name", "Block " + (index + 1)));
    open.appendChild(el("span", "line", "L" + hunk.anchorLine));
    row.appendChild(open);
    const detail = el("div", "row-meta");
    detail.appendChild(stats(hunk.added, hunk.removed));
    const controls = el("div", "row-controls");
    const payload = { changeId: file.id, hunkId: hunk.id };
    if (hunk.decision === "pending") {
      controls.appendChild(button("", "Accept block " + (index + 1), function () { send("acceptHunk", payload); }, "icon-button accept", "check", hunk.id + "-accept"));
      controls.appendChild(button("", "Reject block " + (index + 1), function () { send("rejectHunk", payload); }, "icon-button reject", "close", hunk.id + "-reject"));
    } else {
      const accepted = hunk.decision === "accepted";
      const status = el("span", "decision " + (accepted ? "kept" : "discarded"), accepted ? "Accepted" : "Rejected");
      status.title = accepted ? "Accepted" : "Rejected";
      detail.appendChild(status);
      controls.appendChild(button("", "Undo decision for block " + (index + 1), function () { send(accepted ? "rejectHunk" : "acceptHunk", payload); }, "icon-button", "undo", hunk.id + "-undo"));
    }
    detail.appendChild(controls);
    row.appendChild(detail);
    return row;
  }

  function renderFile(file) {
    const wrap = el("article", "file");
    wrap.setAttribute("aria-label", file.path);
    const head = el("div", "file-head tree-row");
    const open = expanded.has(file.id);
    const toggle = button("", (open ? "Collapse " : "Expand ") + file.path, function () {
      toggleFile(file);
    }, "tree-label file-link", null, file.id + "-toggle");
    toggle.dataset.treeNode = "true";
    toggle.addEventListener("keydown", function (event) { treeKeys(event, file); });
    toggle.setAttribute("aria-expanded", String(open));
    toggle.setAttribute("aria-controls", "blocks-" + file.id);
    const twisty = el("span", "twisty" + (open ? " expanded" : ""));
    twisty.appendChild(icon("chevron"));
    toggle.appendChild(twisty);
    toggle.appendChild(icon("file"));
    const filePath = file.path.replace(/\\/g, "/");
    const label = el("span", "name", filePath);
    label.title = filePath;
    toggle.appendChild(label);
    head.appendChild(toggle);
    const meta = el("div", "row-meta");
    if (file.isNew || file.isDeleted || file.binary) meta.appendChild(el("span", "file-kind " + (file.isNew ? "add" : file.isDeleted ? "del" : ""), file.isNew ? "A" : file.isDeleted ? "D" : "B"));
    if (!file.binary && file.pending) {
      const pending = el("span", "pending", String(file.pending));
      pending.title = file.pending + " blocks pending";
      meta.appendChild(pending);
    }
    const controls = el("div", "row-controls");
    controls.appendChild(button("", "Open review for " + file.path, function () { send("openDiff", { changeId: file.id }); }, "icon-button", "open", file.id + "-open"));
    controls.appendChild(button("", "Accept all changes in " + file.path, function () { send("acceptFile", { changeId: file.id }); }, "icon-button accept", "check", file.id + "-accept"));
    controls.appendChild(button("", "Reject all changes in " + file.path, function () { send("rejectFile", { changeId: file.id }); }, "icon-button reject", "close", file.id + "-reject"));
    meta.appendChild(controls);
    head.appendChild(meta);
    wrap.appendChild(head);
    const blocks = el("ol", "hunks");
    blocks.id = "blocks-" + file.id;
    blocks.hidden = !open;
    for (let i = 0; i < file.hunks.length; i++) blocks.appendChild(renderHunk(file, file.hunks[i], i));
    if (file.binary && open) blocks.appendChild(el("li", "binary-note", "Binary file · review as a whole file."));
    wrap.appendChild(blocks);
    return wrap;
  }

  function render(next) {
    const prevScroll = window.scrollY || 0;
    const focusKey = document.activeElement && document.activeElement.dataset.focusKey;
    state = next;
    root.textContent = "";
    const panel = el("main", "panel");
    const files = next.groups.flatMap(function (group) { return group.files; });
    const pending = files.reduce(function (sum, file) { return sum + (file.binary ? 1 : file.pending); }, 0);
    const header = el("header", "header");
    const heading = el("div", "heading");
    const title = el("div", "title-row");
    title.appendChild(el("h1", "", "Changes"));
    title.appendChild(el("span", "count", String(next.totalFiles)));
    heading.appendChild(title);
    heading.appendChild(el("p", "subtitle", next.totalFiles ? pending + " " + (pending === 1 ? "block" : "blocks") + " waiting for your review" : "Your review queue is clear"));
    header.appendChild(heading);
    if (next.totalFiles) header.appendChild(stats(next.added, next.removed));
    panel.appendChild(header);

    const content = el("div", "content");
    if (!next.totalFiles) {
      const empty = el("section", "empty");
      const emblem = el("div", "empty-icon");
      emblem.appendChild(icon("check"));
      empty.appendChild(emblem);
      empty.appendChild(el("h2", "", "All caught up"));
      empty.appendChild(el("p", "", "New AI changes will appear here when they’re ready for review."));
      const tip = el("div", "empty-tip");
      tip.appendChild(icon("layers"));
      tip.appendChild(el("span", "", "Review each block in the editor. Keep what works, reject what doesn’t."));
      empty.appendChild(tip);
      content.appendChild(empty);
    } else {
      const actions = el("div", "actions");
      actions.appendChild(button("Accept all", "Accept all changes in all listed projects", function () { send("acceptAll"); }, "primary", "check", "accept-all"));
      actions.appendChild(button("Reject all", "Reject all changes in all listed projects", function () { send("rejectAll"); }, "secondary", "close", "reject-all"));
      content.appendChild(actions);
      for (const group of next.groups) {
        const section = el("section", "workspace");
        if (next.groups.length > 1) {
          const label = el("h2", "group", group.label);
          label.title = group.workspace;
          section.appendChild(label);
        }
        for (const file of group.files) section.appendChild(renderFile(file));
        content.appendChild(section);
      }
    }
    panel.appendChild(content);
    const footer = el("footer", "panel-footer");
    if (next.checkpoint) {
      const details = el("details", "checkpoint");
      const summary = el("summary", "", "Checkpoint");
      summary.appendChild(el("span", "", next.checkpoint.files + " files"));
      details.appendChild(summary);
      details.appendChild(el("p", "", "A saved reference of your workspace. New AI reviews start from the current file."));
      details.appendChild(button("Update checkpoint", "Accept the current workspace state as a new checkpoint", function () { send("setCheckpoint"); }, "secondary", null, "checkpoint"));
      footer.appendChild(details);
    }
    footer.appendChild(el("p", "save-note", "Changes are already on disk. Accept keeps them; Reject restores the previous code."));
    panel.appendChild(footer);
    root.appendChild(panel);
    if (focusKey) {
      const target = Array.from(root.querySelectorAll("[data-focus-key]")).find(function (node) { return node.dataset.focusKey === focusKey; });
      if (target) {
        // Reveal row actions before restoring focus to a button hidden until focus/hover.
        const row = target.closest(".tree-row, .hunk");
        const label = row && row.querySelector("[data-tree-node]");
        if (label && label !== target) label.focus({ preventScroll: true });
        target.focus({ preventScroll: true });
      }
    }
    window.scrollTo(0, prevScroll);
  }

  window.addEventListener("message", function (event) {
    const msg = event.data;
    if (msg && msg.type === "update") render(msg.state);
  });
  send("ready");
})();
