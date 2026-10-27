package com.reviewhub.hub

import com.intellij.openapi.components.Service
import com.intellij.openapi.diagnostic.Logger
import com.intellij.openapi.project.Project
import com.reviewhub.model.ChangeSummary
import com.reviewhub.model.HubEntry
import kotlinx.serialization.json.Json
import java.io.File
import java.nio.file.Paths

@Service(Service.Level.PROJECT)
class HubManager(private val project: Project) {
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

    init {
        connect()
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
            Thread.sleep(500)
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

        logger.warn("Could not find or launch Review Hub server")
        return false
    }

    fun refresh() {
        val c = client ?: return
        val workspace = project.basePath ?: return
        try {
            changes = c.listChanges(workspace)
            notifyListeners()
        } catch (e: Exception) {
            logger.error("Failed to refresh changes from Review Hub", e)
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
}
