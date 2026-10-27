package com.reviewhub.actions

import com.intellij.icons.AllIcons
import com.intellij.openapi.actionSystem.AnAction
import com.intellij.openapi.actionSystem.AnActionEvent
import com.intellij.openapi.application.ApplicationManager
import com.intellij.openapi.ui.Messages
import com.reviewhub.hub.HubManager
import java.io.File

class CreateTestChangeAction : AnAction("Simulate Agent Change", "Stage a test change to demo diff review", AllIcons.Actions.Lightning) {
    override fun actionPerformed(e: AnActionEvent) {
        val project = e.project ?: return
        val hubManager = project.getService(HubManager::class.java)
        val client = hubManager.client
        val workspace = project.basePath ?: return

        if (client == null) {
            Messages.showWarningDialog(project, "Review Hub is not connected. Make sure the Hub server is running.", "Review Hub")
            return
        }

        ApplicationManager.getApplication().executeOnPooledThread {
            val testPath = "DEMO_REVIEW.md"
            val testFile = File(workspace, testPath)
            if (!testFile.exists()) {
                testFile.writeText("# Demo Review File\n\nThis is the original baseline content on disk.\n", Charsets.UTF_8)
            }

            val proposed = """
# Demo Review File (Modified by AI Agent)

This line was edited by the agent!
+ [Added Line] Tested in JetBrains Platform Diff Viewer.
+ [Added Line] Per-hunk Accept and Reject support!
""".trimIndent()

            val ok = client.propose(workspace, testPath, proposed)
            if (ok) {
                hubManager.refresh()
                ApplicationManager.getApplication().invokeLater {
                    Messages.showInfoMessage(
                        project,
                        "Successfully staged a test change for '$testPath'!\nDouble click it in the Review Hub panel to view the JetBrains Diff.",
                        "Test Change Staged"
                    )
                }
            } else {
                ApplicationManager.getApplication().invokeLater {
                    Messages.showErrorDialog(project, "Failed to propose test change to Review Hub.", "Error")
                }
            }
        }
    }
}
