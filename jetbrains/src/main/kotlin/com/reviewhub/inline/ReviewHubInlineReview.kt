package com.reviewhub.inline

import com.intellij.icons.AllIcons
import com.intellij.openapi.actionSystem.ActionGroup
import com.intellij.openapi.actionSystem.AnAction
import com.intellij.openapi.actionSystem.AnActionEvent
import com.intellij.openapi.actionSystem.DefaultActionGroup
import com.intellij.openapi.application.ApplicationManager
import com.intellij.openapi.editor.Editor
import com.intellij.openapi.editor.EditorCustomElementRenderer
import com.intellij.openapi.editor.Inlay
import com.intellij.openapi.editor.colors.EditorFontType
import com.intellij.openapi.editor.markup.*
import com.intellij.openapi.project.Project
import com.intellij.openapi.util.Key
import com.intellij.openapi.vfs.LocalFileSystem
import com.intellij.ui.EditorNotifications
import com.intellij.ui.JBColor
import com.reviewhub.hub.HubManager
import com.reviewhub.model.Hunk
import java.awt.Color
import java.awt.Font
import java.awt.Graphics
import java.awt.Rectangle
import java.io.File
import javax.swing.Icon

object ReviewHubInlineReview {
    private val INLAYS_KEY = Key.create<MutableList<Inlay<*>>>("reviewhub.inlays")
    private val HIGHLIGHTERS_KEY = Key.create<MutableList<RangeHighlighter>>("reviewhub.highlighters")

    private val GREEN_BG = JBColor(Color(0xE6, 0xFF, 0xED), Color(0x1F, 0x3A, 0x2B))
    private val RED_BG = JBColor(Color(0xFF, 0xEB, 0xEC), Color(0x3E, 0x22, 0x24))
    private val RED_TEXT = JBColor(Color(0xCB, 0x24, 0x31), Color(0xF8, 0x51, 0x49))
    private val BORDER_COLOR = JBColor(Color(0xF9, 0x75, 0x83), Color(0x6E, 0x1A, 0x24))

    fun clear(editor: Editor) {
        val inlays = editor.getUserData(INLAYS_KEY)
        inlays?.forEach { it.dispose() }
        inlays?.clear()

        val highlighters = editor.getUserData(HIGHLIGHTERS_KEY)
        highlighters?.forEach { editor.markupModel.removeHighlighter(it) }
        highlighters?.clear()
    }

    fun updateInlays(project: Project, editor: Editor, relPath: String) {
        val hubManager = project.getService(HubManager::class.java)
        val client = hubManager.client ?: return
        val workspace = project.basePath ?: return

        ApplicationManager.getApplication().executeOnPooledThread {
            val changeSummary = hubManager.changes.find { it.path == relPath && it.status == "pending" }
            if (changeSummary == null) {
                ApplicationManager.getApplication().invokeLater {
                    clear(editor)
                }
                return@executeOnPooledThread
            }

            val changeSet = client.getChange(changeSummary.id, workspace) ?: return@executeOnPooledThread

            ApplicationManager.getApplication().invokeLater {
                if (project.isDisposed || editor.isDisposed) return@invokeLater
                render(project, editor, changeSet.id, changeSet.hunks, workspace, relPath)
            }
        }
    }

    private fun render(
        project: Project,
        editor: Editor,
        changeId: String,
        hunks: List<Hunk>,
        workspace: String,
        relPath: String
    ) {
        clear(editor)

        val activeInlays = mutableListOf<Inlay<*>>()
        val activeHighlighters = mutableListOf<RangeHighlighter>()
        val doc = editor.document
        if (doc.lineCount == 0) return

        for ((index, hunk) in hunks.withIndex()) {
            if (hunk.decision != "pending") continue

            val targetLine = hunk.newStart.coerceIn(0, doc.lineCount - 1)
            val lineStartOffset = doc.getLineStartOffset(targetLine)

            // 1. Render Deleted Lines (Block Inlay in Red)
            if (hunk.oldLines.isNotEmpty()) {
                val renderer = DeletedLinesBlockRenderer(index + 1, hunk.oldLines, editor)
                val inlay = editor.inlayModel.addBlockElement(
                    lineStartOffset,
                    false, // relatesToPrecedingText
                    true,  // showAbove
                    0,     // priority
                    renderer
                )
                if (inlay != null) {
                    activeInlays.add(inlay)
                }
            }

            // 2. Render Added Lines (Green background range highlight)
            val startLine = targetLine
            val endLine = if (hunk.newLines.isNotEmpty()) {
                (hunk.newStart + hunk.newLines.size - 1).coerceIn(0, doc.lineCount - 1)
            } else {
                startLine
            }
            val startOffset = doc.getLineStartOffset(startLine)
            val endOffset = doc.getLineEndOffset(endLine)

            val attributes = if (hunk.newLines.isNotEmpty()) {
                TextAttributes().apply { backgroundColor = GREEN_BG }
            } else {
                TextAttributes()
            }

            val highlighter = editor.markupModel.addRangeHighlighter(
                startOffset,
                endOffset,
                HighlighterLayer.SELECTION - 1,
                attributes,
                HighlighterTargetArea.LINES_IN_RANGE
            )

            // Gutter actions: Accept hunk / Reject hunk
            highlighter.gutterIconRenderer = HunkGutterRenderer(project, changeId, hunk.id, index + 1, workspace, relPath)
            activeHighlighters.add(highlighter)
        }

        editor.putUserData(INLAYS_KEY, activeInlays)
        editor.putUserData(HIGHLIGHTERS_KEY, activeHighlighters)
    }

    private class HunkGutterRenderer(
        private val project: Project,
        private val changeId: String,
        private val hunkId: String,
        private val hunkNumber: Int,
        private val workspace: String,
        private val relPath: String
    ) : GutterIconRenderer() {

        override fun getIcon(): Icon = AllIcons.Actions.Checked

        override fun getTooltipText(): String = "Review Hub: Hunk #$hunkNumber (Click to Accept, Right-click for options)"

        override fun getClickAction(): AnAction = object : AnAction() {
            override fun actionPerformed(e: AnActionEvent) {
                decideHunk("accept")
            }
        }

        override fun getPopupMenuActions(): ActionGroup = DefaultActionGroup().apply {
            add(object : AnAction("Accept Hunk #$hunkNumber", "Apply this hunk to disk", AllIcons.Actions.Checked) {
                override fun actionPerformed(e: AnActionEvent) {
                    decideHunk("accept")
                }
            })
            add(object : AnAction("Reject Hunk #$hunkNumber", "Discard this hunk and keep baseline", AllIcons.Actions.Cancel) {
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

        override fun equals(other: Any?): Boolean = other is HunkGutterRenderer && other.hunkId == hunkId
        override fun hashCode(): Int = hunkId.hashCode()
    }

    private class DeletedLinesBlockRenderer(
        private val hunkNumber: Int,
        private val lines: List<String>,
        private val editor: Editor
    ) : EditorCustomElementRenderer {

        override fun calcWidthInPixels(inlay: Inlay<*>): Int {
            return editor.component.width.coerceAtLeast(600)
        }

        override fun calcHeightInPixels(inlay: Inlay<*>): Int {
            val lineHeight = editor.lineHeight
            return lineHeight * (lines.size + 1) + 4
        }

        override fun paint(inlay: Inlay<*>, g: Graphics, targetRegion: Rectangle, textAttributes: TextAttributes) {
            val g2 = g.create()
            try {
                val lineHeight = editor.lineHeight
                val font = editor.colorsScheme.getFont(EditorFontType.PLAIN)
                g2.font = font

                // Background
                g2.color = RED_BG
                g2.fillRect(targetRegion.x, targetRegion.y, targetRegion.width, targetRegion.height)

                // Left border indicator
                g2.color = BORDER_COLOR
                g2.fillRect(targetRegion.x, targetRegion.y, 4, targetRegion.height)

                // Header
                g2.color = RED_TEXT
                g2.font = font.deriveFont(Font.BOLD)
                val ascent = g2.fontMetrics.ascent
                g2.drawString(
                    "▼ Hunk #$hunkNumber (Deleted from baseline - click gutter ✓ to accept):",
                    targetRegion.x + 12,
                    targetRegion.y + ascent + 2
                )

                // Deleted code lines
                g2.font = font
                var yOffset = targetRegion.y + lineHeight + 2
                for (line in lines) {
                    g2.drawString("- $line", targetRegion.x + 12, yOffset + ascent)
                    yOffset += lineHeight
                }
            } finally {
                g2.dispose()
            }
        }
    }
}
