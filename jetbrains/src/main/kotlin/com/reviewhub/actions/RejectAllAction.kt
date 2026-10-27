package com.reviewhub.actions

import com.intellij.openapi.actionSystem.AnAction
import com.intellij.openapi.actionSystem.AnActionEvent
import com.intellij.openapi.application.ApplicationManager
import com.intellij.openapi.ui.Messages
import com.reviewhub.hub.HubManager

class RejectAllAction : AnAction() {
    override fun actionPerformed(e: AnActionEvent) {
        val project = e.project ?: return
        val hubManager = project.getService(HubManager::class.java)
        val client = hubManager.client ?: return
        val workspace = project.basePath ?: return

        val confirm = Messages.showYesNoDialog(
            project,
            "Are you sure you want to reject all pending changes and restore baseline?",
            "Reject All Changes",
            Messages.getWarningIcon()
        )
        if (confirm != Messages.YES) return

        ApplicationManager.getApplication().executeOnPooledThread {
            val pendingFiles = hubManager.changes
            for (change in pendingFiles) {
                client.reject(changeId = change.id, workspace = workspace)
            }
            hubManager.refresh()
        }
    }
}
