package com.reviewhub.status

import com.intellij.ide.projectView.PresentationData
import com.intellij.ide.projectView.ProjectViewNode
import com.intellij.ide.projectView.ProjectViewNodeDecorator
import com.intellij.ui.SimpleTextAttributes
import com.reviewhub.hub.HubManager
import java.nio.file.Paths

class ReviewHubNodeDecorator : ProjectViewNodeDecorator {
    override fun decorate(node: ProjectViewNode<*>, data: PresentationData) {
        val project = node.project ?: return
        val virtualFile = node.virtualFile ?: return
        val basePath = project.basePath ?: return

        val filePath = virtualFile.path
        if (!filePath.startsWith(basePath)) return

        val relPath = try {
            Paths.get(basePath).relativize(Paths.get(filePath)).toString().replace('\\', '/')
        } catch (_: Exception) {
            return
        }

        val hubManager = project.getService(HubManager::class.java)
        val change = hubManager.changes.find { it.path == relPath && it.status == "pending" } ?: return

        data.addText(" [${change.pending} hunk(s)]", SimpleTextAttributes.GRAYED_SMALL_ATTRIBUTES)
    }
}
