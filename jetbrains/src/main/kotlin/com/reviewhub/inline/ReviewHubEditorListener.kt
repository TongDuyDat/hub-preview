package com.reviewhub.inline

import com.intellij.openapi.fileEditor.FileEditorManager
import com.intellij.openapi.fileEditor.FileEditorManagerEvent
import com.intellij.openapi.fileEditor.FileEditorManagerListener
import com.intellij.openapi.fileEditor.TextEditor
import com.intellij.openapi.vfs.VirtualFile

class ReviewHubEditorListener : FileEditorManagerListener {
    override fun fileOpened(source: FileEditorManager, file: VirtualFile) {
        update(source, file)
    }

    override fun selectionChanged(event: FileEditorManagerEvent) {
        val file = event.newFile ?: return
        update(event.manager, file)
    }

    private fun update(manager: FileEditorManager, file: VirtualFile) {
        val project = manager.project
        val basePath = project.basePath ?: return
        val filePath = file.path
        if (!filePath.startsWith(basePath)) return

        val relPath = filePath.substring(basePath.length).trimStart('/', '\\').replace('\\', '/')
        val editor = (manager.getSelectedEditor(file) as? TextEditor)?.editor ?: return
        ReviewHubInlineReview.updateInlays(project, editor, relPath)
    }
}
