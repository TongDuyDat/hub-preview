package com.reviewhub.inline

import com.intellij.openapi.fileEditor.FileEditor
import com.intellij.openapi.fileEditor.TextEditor
import com.intellij.openapi.project.Project
import com.intellij.openapi.vfs.VirtualFile
import com.intellij.ui.EditorNotificationPanel
import com.intellij.ui.EditorNotificationProvider
import com.intellij.ui.EditorNotifications
import com.reviewhub.diff.ReviewHubDiffViewer
import com.reviewhub.hub.HubManager
import java.util.function.Function
import javax.swing.JComponent

class ReviewHubNotificationProvider : EditorNotificationProvider {
    override fun collectNotificationData(
        project: Project,
        file: VirtualFile
    ): Function<in FileEditor, out JComponent?>? {
        val hubManager = project.getService(HubManager::class.java)
        val basePath = project.basePath ?: return null
        val filePath = file.path
        if (!filePath.startsWith(basePath)) return null

        val relPath = filePath.substring(basePath.length).trimStart('/', '\\').replace('\\', '/')
        val change = hubManager.changes.find { it.path == relPath && it.status == "pending" } ?: return null

        return Function { fileEditor ->
            val panel = EditorNotificationPanel(fileEditor, EditorNotificationPanel.Status.Warning)
            panel.text = "Review Hub: ${change.pending} pending hunk(s) from AI Agent."

            panel.createActionLabel("✓ Accept All") {
                val client = hubManager.client ?: return@createActionLabel
                client.accept(changeId = change.id, workspace = basePath)
                hubManager.refresh()
                file.refresh(true, false)
                EditorNotifications.getInstance(project).updateNotifications(file)
            }

            panel.createActionLabel("✗ Reject All") {
                val client = hubManager.client ?: return@createActionLabel
                client.reject(changeId = change.id, workspace = basePath)
                hubManager.refresh()
                file.refresh(true, false)
                EditorNotifications.getInstance(project).updateNotifications(file)
            }

            panel.createActionLabel("🔍 Side-by-Side Diff") {
                ReviewHubDiffViewer.showDiff(project, change)
            }

            // Also attach inline inlays if it's a TextEditor
            if (fileEditor is TextEditor) {
                ReviewHubInlineReview.updateInlays(project, fileEditor.editor, relPath)
            }

            panel
        }
    }
}
