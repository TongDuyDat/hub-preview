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

  function button(label, title, onClick) {
    const b = el("button", "btn", label);
    b.title = title;
    b.addEventListener("click", function (e) {
      e.stopPropagation();
      onClick();
    });
    return b;
  }

  function renderFile(file) {
    const row = el("div", "file-row");
    row.appendChild(el("span", "name", file.name));
    if (file.dir) row.appendChild(el("span", "dir", file.dir));
    if (file.isNew) row.appendChild(el("span", "badge ok", "new"));
    if (file.isDeleted) row.appendChild(el("span", "badge no", "deleted"));
    if (file.binary) row.appendChild(el("span", "badge", "binary"));
    row.appendChild(el("span", "spacer"));
    if (file.added > 0) row.appendChild(el("span", "stat add", "+" + file.added));
    if (file.removed > 0) row.appendChild(el("span", "stat del", "\u2212" + file.removed));
    row.addEventListener("click", function () {
      send("openFile", { changeId: file.id });
    });
    return row;
  }

  function render(next) {
    const prevScroll = window.scrollY || document.documentElement.scrollTop || 0;
    state = next;
    root.textContent = "";

    const header = el("div", "header");
    header.appendChild(el("span", "count", next.totalFiles + (next.totalFiles === 1 ? " file" : " files")));
    header.appendChild(el("span", "spacer"));
    header.appendChild(el("span", "stat add", "+" + next.added));
    header.appendChild(el("span", "stat del", "\u2212" + next.removed));
    root.appendChild(header);

    if (next.totalFiles === 0) {
      const actions = el("div", "actions");
      actions.appendChild(button("\u27f3 Checkpoint", "Set a new checkpoint (accept the current state)", function () {
        send("setCheckpoint");
      }));
      root.appendChild(actions);

      const cp = next.checkpoint
        ? "Checkpoint: " + next.checkpoint.files + " files"
        : "No checkpoint set — changes are measured from now.";
      root.appendChild(el("div", "empty", "No changes to review. " + cp));
      return;
    }

    const actions = el("div", "actions");
    actions.appendChild(button("\u2713 Accept All", "Accept every change in every project", function () {
      send("acceptAll");
    }));
    actions.appendChild(button("\u21ba Discard All", "Reject every change in every project", function () {
      send("rejectAll");
    }));
    actions.appendChild(button("\u27f3 Checkpoint", "Set a new checkpoint (accept the current state)", function () {
      send("setCheckpoint");
    }));
    root.appendChild(actions);

    for (const group of next.groups) {
      if (next.groups.length > 1) root.appendChild(el("div", "group", group.label));
      for (const file of group.files) root.appendChild(renderFile(file));
    }
    window.scrollTo(0, prevScroll);
  }

  window.addEventListener("message", function (event) {
    const msg = event.data;
    if (msg && msg.type === "update") render(msg.state);
  });

  send("ready");
})();
