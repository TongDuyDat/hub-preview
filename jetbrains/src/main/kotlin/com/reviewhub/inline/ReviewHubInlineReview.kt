package com.reviewhub.inline

import com.intellij.openapi.application.ApplicationManager
import com.intellij.openapi.editor.Editor
import com.intellij.openapi.editor.EditorCustomElementRenderer
import com.intellij.openapi.editor.Inlay
import com.intellij.openapi.editor.colors.EditorFontType
import com.intellij.openapi.editor.markup.*
import com.intellij.openapi.project.Project
import com.intellij.openapi.util.Key
import com.intellij.ui.JBColor
import com.reviewhub.hub.HubManager
import com.reviewhub.model.Hunk
import java.awt.Color
import java.awt.Font
import java.awt.Graphics
import java.awt.Rectangle

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
                render(project, editor, changeSet.id, changeSet.hunks, workspace)
            }
        }
    }

    private fun render(project: Project, editor: Editor, changeId: String, hunks: List<Hunk>, workspace: String) {
        clear(editor)

        val activeInlays = mutableListOf<Inlay<*>>()
        val activeHighlighters = mutableListOf<RangeHighlighter>()
        val doc = editor.document

        for ((index, hunk) in hunks.withIndex()) {
            if (hunk.decision != "pending") continue

            // 1. Render Deleted Lines (Block Inlay in Red)
            if (hunk.oldLines.isNotEmpty()) {
                val lineIndex = hunk.newStart.coerceIn(0, doc.lineCount - 1)
                val lineStartOffset = doc.getLineStartOffset(lineIndex)

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
            if (hunk.newLines.isNotEmpty()) {
                val startLine = hunk.newStart.coerceIn(0, doc.lineCount - 1)
                val endLine = (hunk.newStart + hunk.newLines.size - 1).coerceIn(0, doc.lineCount - 1)
                val startOffset = doc.getLineStartOffset(startLine)
                val endOffset = doc.getLineEndOffset(endLine)

                val attributes = TextAttributes().apply {
                    backgroundColor = GREEN_BG
                }

                val highlighter = editor.markupModel.addRangeHighlighter(
                    startOffset,
                    endOffset,
                    HighlighterLayer.SELECTION - 1,
                    attributes,
                    HighlighterTargetArea.LINES_IN_RANGE
                )
                activeHighlighters.add(highlighter)
            }
        }

        editor.putUserData(INLAYS_KEY, activeInlays)
        editor.putUserData(HIGHLIGHTERS_KEY, activeHighlighters)
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
            // Header (1 line) + deleted lines count
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

                // Left border
                g2.color = BORDER_COLOR
                g2.fillRect(targetRegion.x, targetRegion.y, 4, targetRegion.height)

                // Header
                g2.color = RED_TEXT
                g2.font = font.deriveFont(Font.BOLD)
                val ascent = g2.fontMetrics.ascent
                g2.drawString(
                    "▼ Hunk #$hunkNumber (Deleted lines from baseline):",
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
