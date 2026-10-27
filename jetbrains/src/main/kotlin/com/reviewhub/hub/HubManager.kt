package com.reviewhub.hub

import com.intellij.ide.projectView.ProjectView
import com.intellij.openapi.Disposable
import com.intellij.openapi.application.ApplicationManager
import com.intellij.openapi.components.Service
import com.intellij.openapi.diagnostic.Logger
import com.intellij.openapi.project.Project
import com.intellij.openapi.vcs.FileStatusManager
import com.reviewhub.model.ChangeSummary
import com.reviewhub.model.HubEntry
import kotlinx.serialization.json.Json
import java.io.File
import java.nio.file.Paths
import java.util.Timer
import java.util.TimerTask

@Service(Service.Level.PROJECT)
class HubManager(private val project: Project) : Disposable {
    private val logger = Logger.getInstance(HubManager::class.java)

    private val json = Json {
        ignoreUnknownKeys = true
        isLenient = true
    }

    var client: HubClient? = null
        private set

    var changes: List<ChangeSummary> = emptyList()
        private set

    private val listeners = mutableListOf<() -> Unit>()
    private var pollingTimer: Timer? = null

    init {
        connect()
        startPolling()
    }

    fun addChangeListener(listener: () -> Unit) {
        listeners.add(listener)
    }

    fun removeChangeListener(listener: () -> Unit) {
        listeners.remove(listener)
    }

    private fun notifyListeners() {
        listeners.forEach { it.invoke() }
    }

    private fun startPolling() {
        pollingTimer?.cancel()
        pollingTimer = Timer("ReviewHubPolling", true).apply {
            scheduleAtFixedRate(object : TimerTask() {
                override fun run() {
                    if (project.isDisposed) {
                        cancel()
                        return
                    }
                    if (client == null) {
                        connect()
                    } else {
                        refresh()
                    }
                }
            }, 1000, 2500)
        }
    }

    fun connect(): Boolean {
        val entry = readHubEntry()
        if (entry != null) {
            val candidate = HubClient(entry.url, entry.token)
            if (candidate.healthCheck()) {
                client = candidate
                logger.info("Connected to Review Hub at ${entry.url}")
                refresh()
                return true
            }
        }

        // If not running, attempt to spawn standalone hub daemon
        val spawned = trySpawnHub()
        if (spawned) {
            Thread.sleep(800)
            val newEntry = readHubEntry()
            if (newEntry != null) {
                val candidate = HubClient(newEntry.url, newEntry.token)
                if (candidate.healthCheck()) {
                    client = candidate
                    logger.info("Successfully launched and connected to Review Hub at ${newEntry.url}")
                    refresh()
                    return true
                }
            }
        }

        logger.debug("Review Hub server is not running yet.")
        return false
    }

    fun refresh() {
        val c = client ?: return
        val workspace = project.basePath ?: return
        try {
            val newChanges = c.listChanges(workspace)
            if (newChanges != changes) {
                changes = newChanges
                notifyListeners()
                ApplicationManager.getApplication().invokeLater {
                    if (!project.isDisposed) {
                        FileStatusManager.getInstance(project).fileStatusesChanged()
                        ProjectView.getInstance(project).refresh()
                    }
                }
            }
        } catch (e: Exception) {
            logger.debug("Failed to refresh changes from Review Hub", e)
        }
    }

    fun isPending(path: String): Boolean {
        return changes.any { it.path == path && it.status == "pending" }
    }

    private fun readHubEntry(): HubEntry? {
        val home = System.getProperty("user.home")
        val hubJson = Paths.get(home, ".review-hub", "hub.json").toFile()
        if (!hubJson.exists()) return null
        return try {
            json.decodeFromString<HubEntry>(hubJson.readText(Charsets.UTF_8))
        } catch (e: Exception) {
            logger.warn("Failed to parse hub.json", e)
            null
        }
    }

    private fun trySpawnHub(): Boolean {
        val workspace = project.basePath ?: return false
        val distScript = File(workspace, "dist/hub-server.cjs")
        if (!distScript.exists()) {
            return false
        }

        return try {
            val pb = ProcessBuilder("node", distScript.absolutePath, workspace)
            pb.directory(File(workspace))
            pb.redirectErrorStream(true)
            pb.start()
            true
        } catch (e: Exception) {
            logger.warn("Failed to spawn node hub-server.cjs", e)
            false
        }
    }

    override fun dispose() {
        pollingTimer?.cancel()
        pollingTimer = null
        listeners.clear()
    }
}
