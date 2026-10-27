package com.reviewhub.inline

import com.intellij.icons.AllIcons
import com.intellij.openapi.actionSystem.ActionGroup
import com.intellij.openapi.actionSystem.AnAction
import com.intellij.openapi.actionSystem.AnActionEvent
import com.intellij.openapi.actionSystem.DefaultActionGroup
import com.intellij.openapi.application.ApplicationManager
import com.intellij.openapi.command.WriteCommandAction
import com.intellij.openapi.editor.Editor
import com.intellij.openapi.editor.markup.*
import com.intellij.openapi.project.Project
import com.intellij.openapi.util.Key
import com.intellij.openapi.vfs.LocalFileSystem
import com.intellij.ui.EditorNotifications
import com.intellij.ui.JBColor
import com.reviewhub.hub.HubManager
import java.awt.Color
import java.io.File
import javax.swing.Icon

object ReviewHubInlineReview {
    private val HIGHLIGHTERS_KEY = Key.create<MutableList<RangeHighlighter>>("reviewhub.highlighters")
    private val STAGED_HASH_KEY = Key.create<String>("reviewhub.staged_hash")

    private val GREEN_BG = JBColor(Color(0xE6, 0xFF, 0xED), Color(0x1F, 0x3A, 0x2B))
    private val RED_BG = JBColor(Color(0xFF, 0xEB, 0xEC), Color(0x3E, 0x22, 0x24))

    fun clear(editor: Editor) {
        val highlighters = editor.getUserData(HIGHLIGHTERS_KEY)
        highlighters?.forEach { editor.markupModel.removeHighlighter(it) }
        highlighters?.clear()
        editor.putUserData(STAGED_HASH_KEY, null)
    }

    fun updateInlays(project: Project, editor: Editor, relPath: String) {
        val hubManager = project.getService(HubManager::class.java)
        val client = hubManager.client ?: return
        val workspace = project.basePath ?: return

        ApplicationManager.getApplication().executeOnPooledThread {
            val changeSummary = hubManager.changes.find {
                it.path.equals(relPath, ignoreCase = true) && it.status == "pending"
            }

            if (changeSummary == null) {
                ApplicationManager.getApplication().invokeLater {
                    if (!project.isDisposed && !editor.isDisposed) {
                        clear(editor)
                    }
                }
                return@executeOnPooledThread
            }

            val changeSet = client.getChange(changeSummary.id, workspace) ?: return@executeOnPooledThread

            ApplicationManager.getApplication().invokeLater {
                if (project.isDisposed || editor.isDisposed) return@invokeLater
                render(project, editor, changeSet.id, changeSet.baseline, changeSet.hunks, workspace, relPath)
            }
        }
    }

    private fun render(
        project: Project,
        editor: Editor,
        changeId: String,
        baseline: String,
        hunks: List<com.reviewhub.model.Hunk>,
        workspace: String,
        relPath: String
    ) {
        val merged = MergedDiff.build(baseline, hunks)
        val doc = editor.document

        // Only update document if not already holding this merged text
        val currentHash = "${changeId}_${merged.text.hashCode()}"
        val prevHash = editor.getUserData(STAGED_HASH_KEY)

        if (prevHash != currentHash) {
            WriteCommandAction.runWriteCommandAction(project) {
                if (doc.text != merged.text) {
                    doc.setText(merged.text)
                }
            }
            editor.putUserData(STAGED_HASH_KEY, currentHash)
        }

        clear(editor)
        val activeHighlighters = mutableListOf<RangeHighlighter>()

        for (block in merged.blocks) {
            if (block.kind == MergedBlockKind.CONTEXT) continue

            val startLine = block.startLine.coerceIn(0, (doc.lineCount - 1).coerceAtLeast(0))
            val endLine = (block.endLine - 1).coerceIn(startLine, (doc.lineCount - 1).coerceAtLeast(0))
            val startOffset = doc.getLineStartOffset(startLine)
            val endOffset = doc.getLineEndOffset(endLine)

            val isDeleted = block.kind == MergedBlockKind.DELETED
            val attributes = TextAttributes().apply {
                backgroundColor = if (isDeleted) RED_BG else GREEN_BG
            }

            val highlighter = editor.markupModel.addRangeHighlighter(
                startOffset,
                endOffset,
                HighlighterLayer.SELECTION - 1,
                attributes,
                HighlighterTargetArea.LINES_IN_RANGE
            )

            if (block.hunkId != null) {
                highlighter.gutterIconRenderer = HunkGutterRenderer(
                    project,
                    changeId,
                    block.hunkId,
                    block.hunkIndex,
                    isDeleted,
                    workspace,
                    relPath
                )
            }
            activeHighlighters.add(highlighter)
        }

        editor.putUserData(HIGHLIGHTERS_KEY, activeHighlighters)
    }

    private class HunkGutterRenderer(
        private val project: Project,
        private val changeId: String,
        private val hunkId: String,
        private val hunkNumber: Int,
        private val isDeleted: Boolean,
        private val workspace: String,
        private val relPath: String
    ) : GutterIconRenderer() {

        override fun getIcon(): Icon = if (isDeleted) AllIcons.Actions.Cancel else AllIcons.Actions.Checked

        override fun getTooltipText(): String = if (isDeleted) {
            "Review Hub: Removed lines in Hunk #$hunkNumber (Click to Reject, Right-click to Accept)"
        } else {
            "Review Hub: Added lines in Hunk #$hunkNumber (Click to Accept, Right-click to Reject)"
        }

        override fun getClickAction(): AnAction = object : AnAction() {
            override fun actionPerformed(e: AnActionEvent) {
                // Clicking deleted lines defaults to reject; clicking added lines defaults to accept
                decideHunk(if (isDeleted) "reject" else "accept")
            }
        }

        override fun getPopupMenuActions(): ActionGroup = DefaultActionGroup().apply {
            add(object : AnAction("Accept Hunk #$hunkNumber", "Apply this hunk to disk", AllIcons.Actions.Checked) {
                override fun actionPerformed(e: AnActionEvent) {
                    decideHunk("accept")
                }
            })
            add(object : AnAction("Reject Hunk #$hunkNumber", "Discard this hunk", AllIcons.Actions.Cancel) {
                override fun actionPerformed(e: AnActionEvent) {
                    decideHunk("reject")
                }
            })
        }

        private fun decideHunk(kind: String) {
            val hubManager = project.getService(HubManager::class.java)
            val client = hubManager.client ?: return
            ApplicationManager.getApplication().executeOnPooledThread {
                if (kind == "accept") {
                    client.accept(changeId = changeId, workspace = workspace, hunkIds = listOf(hunkId))
                } else {
                    client.reject(changeId = changeId, workspace = workspace, hunkIds = listOf(hunkId))
                }
                hubManager.refresh()
                ApplicationManager.getApplication().invokeLater {
                    val file = File(workspace, relPath)
                    val vf = LocalFileSystem.getInstance().findFileByIoFile(file)
                    vf?.refresh(true, false)
                    if (vf != null) {
                        EditorNotifications.getInstance(project).updateNotifications(vf)
                    }
                }
            }
        }

        override fun equals(other: Any?): Boolean = other is HunkGutterRenderer && other.hunkId == hunkId && other.isDeleted == isDeleted
        override fun hashCode(): Int = hunkId.hashCode() * 31 + isDeleted.hashCode()
    }
}
