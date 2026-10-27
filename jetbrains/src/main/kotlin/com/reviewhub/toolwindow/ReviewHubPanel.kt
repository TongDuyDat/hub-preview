package com.reviewhub.toolwindow

import com.intellij.openapi.actionSystem.ActionManager
import com.intellij.openapi.actionSystem.DefaultActionGroup
import com.intellij.openapi.application.ApplicationManager
import com.intellij.openapi.project.Project
import com.intellij.openapi.ui.SimpleToolWindowPanel
import com.intellij.ui.ColoredListCellRenderer
import com.intellij.ui.SimpleTextAttributes
import com.intellij.ui.components.JBList
import com.intellij.ui.components.JBScrollPane
import com.reviewhub.diff.ReviewHubDiffViewer
import com.reviewhub.hub.HubManager
import com.reviewhub.model.ChangeSummary
import java.awt.BorderLayout
import java.awt.event.MouseAdapter
import java.awt.event.MouseEvent
import javax.swing.DefaultListModel
import javax.swing.JLabel
import javax.swing.JList
import javax.swing.JPanel
import javax.swing.border.EmptyBorder

class ReviewHubPanel(private val project: Project) : SimpleToolWindowPanel(true, true) {
    private val hubManager = project.getService(HubManager::class.java)
    private val listModel = DefaultListModel<ChangeSummary>()
    private val changeList = JBList(listModel)
    private val statusLabel = JLabel("Ready")

    init {
        setupToolbar()
        setupUI()
        setupListeners()
        refreshList()
    }

    private fun setupToolbar() {
        val actionManager = ActionManager.getInstance()
        val group = actionManager.getAction("ReviewHub.ToolBar") as? DefaultActionGroup
            ?: DefaultActionGroup()
        val toolbar = actionManager.createActionToolbar("ReviewHubToolbar", group, true)
        toolbar.targetComponent = this
        setToolbar(toolbar.component)
    }

    private fun setupUI() {
        changeList.cellRenderer = object : ColoredListCellRenderer<ChangeSummary>() {
            override fun customizeCellRenderer(
                list: JList<out ChangeSummary>,
                value: ChangeSummary?,
                index: Int,
                selected: Boolean,
                hasFocus: Boolean
            ) {
                if (value == null) return

                val badge = if (value.status == "applied") " [Applied] " else " "
                append(badge, SimpleTextAttributes.GRAY_ATTRIBUTES)

                append(value.path, SimpleTextAttributes.REGULAR_BOLD_ATTRIBUTES)

                val stats = " (+${value.added} / -${value.removed}) [${value.pending} hunks pending]"
                append(stats, SimpleTextAttributes.GRAYED_SMALL_ATTRIBUTES)
            }
        }

        changeList.addMouseListener(object : MouseAdapter() {
            override fun mouseClicked(e: MouseEvent) {
                if (e.clickCount == 2) {
                    val selected = changeList.selectedValue
                    if (selected != null) {
                        ReviewHubDiffViewer.showDiff(project, selected)
                    }
                }
            }
        })

        val contentPanel = JPanel(BorderLayout())
        contentPanel.add(JBScrollPane(changeList), BorderLayout.CENTER)

        val bottomPanel = JPanel(BorderLayout())
        bottomPanel.border = EmptyBorder(4, 8, 4, 8)
        bottomPanel.add(statusLabel, BorderLayout.WEST)
        contentPanel.add(bottomPanel, BorderLayout.SOUTH)

        setContent(contentPanel)
    }

    private fun setupListeners() {
        hubManager.addChangeListener {
            ApplicationManager.getApplication().invokeLater {
                refreshList()
            }
        }
    }

    fun refreshList() {
        listModel.clear()
        val list = hubManager.changes
        for (item in list) {
            listModel.addElement(item)
        }

        if (hubManager.client == null) {
            statusLabel.text = "Not connected to Review Hub"
        } else if (list.isEmpty()) {
            statusLabel.text = "No pending changes"
        } else {
            val totalHunks = list.sumOf { it.pending }
            statusLabel.text = "${list.size} file(s), $totalHunks pending hunk(s)"
        }
    }
}
