package com.reviewhub.util

import com.intellij.openapi.project.Project
import com.intellij.openapi.vfs.VirtualFile

object PathUtil {
    fun toRelativePath(project: Project, file: VirtualFile): String? {
        val basePath = project.basePath ?: return null
        return toRelativePath(basePath, file.path)
    }

    fun toRelativePath(basePath: String, filePath: String): String? {
        val normBase = basePath.replace('\\', '/').trimEnd('/')
        val normFile = filePath.replace('\\', '/')
        if (!normFile.startsWith(normBase, ignoreCase = true)) {
            return null
        }
        return normFile.substring(normBase.length).trimStart('/')
    }
}
