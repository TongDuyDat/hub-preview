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
    b.addEventListener("click", onClick);
    return b;
  }

  function renderBar(s) {
    const bar = el("div", "bar");
    const path = [s.dir, s.name].filter(Boolean).join("/");
    const name = el("span", "name", path);
    name.title = path;
    bar.appendChild(name);
    bar.appendChild(el("span", "stat", "+" + s.added + " \u2212" + s.removed));
    if (s.status === "resolved") bar.appendChild(el("span", "stat", "Reviewed"));
    bar.appendChild(el("span", "spacer"));
    bar.appendChild(button("\u2713 Accept All", "Keep all proposed changes in this file", function () {
      send("acceptFile", { changeId: s.changeId });
    }));
    bar.appendChild(button("\u21ba Reject All", "Restore the previous code for all changes in this file", function () {
      send("rejectFile", { changeId: s.changeId });
    }));
    return bar;
  }

  function scrollToHunk(hunkId) {
    if (!hunkId) return;
    const target = document.getElementById("hunk-" + hunkId);
    if (target) {
      target.scrollIntoView({ behavior: "smooth", block: "center" });
      target.classList.add("hunk-highlight");
      setTimeout(function () {
        target.classList.remove("hunk-highlight");
      }, 1500);
    }
  }

  function renderHunkBar(s, hunk) {
    const bar = el("div", "hunkbar");
    bar.id = "hunk-" + hunk.id;
    bar.appendChild(el("span", "stat", "+" + hunk.added + " \u2212" + hunk.removed));
    bar.appendChild(el("span", "spacer"));
    if (hunk.decision === "accepted") {
      bar.appendChild(el("span", "badge ok", "\u2713 accepted"));
      bar.appendChild(button("\u21ba Undo", "Undo — restore previous code", function () {
        send("rejectHunk", { changeId: s.changeId, hunkId: hunk.id });
      }));
    } else if (hunk.decision === "rejected") {
      bar.appendChild(el("span", "badge no", "\u2717 rejected"));
      bar.appendChild(button("\u2713 Undo", "Undo — keep proposed lines", function () {
        send("acceptHunk", { changeId: s.changeId, hunkId: hunk.id });
      }));
    } else {
      bar.appendChild(button("\u2713 Accept", "Keep this hunk's new lines", function () {
        send("acceptHunk", { changeId: s.changeId, hunkId: hunk.id });
      }));
      bar.appendChild(button("\u21ba Reject", "Restore this block's previous code", function () {
        send("rejectHunk", { changeId: s.changeId, hunkId: hunk.id });
      }));
    }
    return bar;
  }

  function render(next, targetHunkId) {
    const prevScroll = window.scrollY || document.documentElement.scrollTop || 0;
    state = next;
    root.textContent = "";
    root.appendChild(renderBar(next));
    if (next.binary) {
      root.appendChild(el("div", "line", "(binary file — accept or reject the whole file from the Review Hub panel)"));
      return;
    }
    const byLine = new Map();
    for (const hunk of next.hunks) {
      const bars = byLine.get(hunk.line) || [];
      bars.push(hunk);
      byLine.set(hunk.line, bars);
    }
    // A deletion at EOF (or a rejected new file) has an anchor after the last line.
    // Keep its decision/Undo bar visible even when the resolved file is empty.
    for (let i = 0; i <= next.lines.length; i++) {
      for (const hunk of byLine.get(i) || []) root.appendChild(renderHunkBar(next, hunk));
      if (i === next.lines.length) break;
      const line = next.lines[i];
      const row = el("div", "line " + line.kind);
      row.appendChild(el("span", "gutter", String(i + 1)));
      row.appendChild(el("span", "text", line.text === "" ? " " : line.text));
      root.appendChild(row);
    }
    if (targetHunkId) {
      scrollToHunk(targetHunkId);
    } else {
      window.scrollTo(0, prevScroll);
    }
  }

  window.addEventListener("message", function (event) {
    const msg = event.data;
    if (msg && msg.type === "update") {
      render(msg.state, msg.targetHunkId);
    } else if (msg && msg.type === "scrollToHunk") {
      scrollToHunk(msg.hunkId);
    }
  });

  send("ready");
})();
