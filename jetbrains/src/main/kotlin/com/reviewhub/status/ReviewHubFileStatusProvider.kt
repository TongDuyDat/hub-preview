package com.reviewhub.status

import com.intellij.openapi.project.Project
import com.intellij.openapi.vcs.FileStatus
import com.intellij.openapi.vcs.impl.FileStatusProvider
import com.intellij.openapi.vfs.VirtualFile
import com.reviewhub.hub.HubManager
import java.nio.file.Paths

class ReviewHubFileStatusProvider(private val project: Project) : FileStatusProvider {
    override fun getFileStatus(virtualFile: VirtualFile): FileStatus? {
        val basePath = project.basePath ?: return null
        val filePath = virtualFile.path
        if (!filePath.startsWith(basePath)) return null

        val relPath = try {
            Paths.get(basePath).relativize(Paths.get(filePath)).toString().replace('\\', '/')
        } catch (_: Exception) {
            return null
        }

        val hubManager = project.getService(HubManager::class.java)
        val change = hubManager.changes.find { it.path == relPath && it.status == "pending" } ?: return null

        return if (change.applied) FileStatus.MODIFIED else FileStatus.ADDED
    }
}
