package com.reviewhub.hub

import com.reviewhub.model.*
import kotlinx.serialization.encodeToString
import kotlinx.serialization.json.Json
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import java.io.IOException
import java.util.concurrent.TimeUnit

class HubClient(
    val baseUrl: String,
    val token: String
) {
    private val client = OkHttpClient.Builder()
        .connectTimeout(5, TimeUnit.SECONDS)
        .readTimeout(15, TimeUnit.SECONDS)
        .build()

    private val json = Json {
        ignoreUnknownKeys = true
        isLenient = true
        encodeDefaults = true
    }

    private val jsonMediaType = "application/json; charset=utf-8".toMediaType()

    fun healthCheck(): Boolean {
        val req = Request.Builder()
            .url("$baseUrl/healthz")
            .header("Authorization", "Bearer $token")
            .get()
            .build()
        return try {
            client.newCall(req).execute().use { it.isSuccessful }
        } catch (_: Exception) {
            false
        }
    }

    fun listChanges(workspace: String): List<ChangeSummary> {
        val candidates = listOf(
            workspace,
            workspace.replace('\\', '/'),
            workspace.replace('/', '\\')
        ).distinct()

        for (ws in candidates) {
            val list = fetchList(ws)
            if (list.isNotEmpty()) return list
        }
        return emptyList()
    }

    private fun fetchList(workspace: String): List<ChangeSummary> {
        val url = "$baseUrl/changes/list?workspace=${java.net.URLEncoder.encode(workspace, "UTF-8")}"
        val req = Request.Builder()
            .url(url)
            .header("Authorization", "Bearer $token")
            .get()
            .build()

        return try {
            client.newCall(req).execute().use { resp ->
                if (!resp.isSuccessful) return emptyList()
                val body = resp.body?.string() ?: return emptyList()
                json.decodeFromString<ListChangesResponse>(body).files
            }
        } catch (_: Exception) {
            emptyList()
        }
    }

    fun propose(workspace: String, path: String, content: String): Boolean {
        val normalizedWs = workspace.replace('\\', '/')
        val map = mapOf(
            "workspace" to normalizedWs,
            "path" to path,
            "content" to content
        )
        val bodyStr = json.encodeToString(map)
        val req = Request.Builder()
            .url("$baseUrl/changes/propose")
            .header("Authorization", "Bearer $token")
            .post(bodyStr.toRequestBody(jsonMediaType))
            .build()

        return try {
            client.newCall(req).execute().use { it.isSuccessful }
        } catch (_: Exception) {
            false
        }
    }

    fun getChange(changeId: String, workspace: String): ChangeSet? {
        val url = "$baseUrl/changes/get?changeId=${java.net.URLEncoder.encode(changeId, "UTF-8")}&workspace=${java.net.URLEncoder.encode(workspace, "UTF-8")}"
        val req = Request.Builder()
            .url(url)
            .header("Authorization", "Bearer $token")
            .get()
            .build()

        client.newCall(req).execute().use { resp ->
            if (!resp.isSuccessful) return null
            val body = resp.body?.string() ?: return null
            return try {
                json.decodeFromString<GetChangeResponse>(body).changeSet
            } catch (_: Exception) {
                null
            }
        }
    }

    fun accept(changeId: String? = null, workspace: String? = null, path: String? = null, hunkIds: List<String>? = null): DecideResult? {
        return decide("/changes/accept", DecideRequest(changeId, path, workspace, hunkIds))
    }

    fun reject(changeId: String? = null, workspace: String? = null, path: String? = null, hunkIds: List<String>? = null): DecideResult? {
        return decide("/changes/reject", DecideRequest(changeId, path, workspace, hunkIds))
    }

    private fun decide(endpoint: String, request: DecideRequest): DecideResult? {
        val bodyStr = json.encodeToString(request)
        val req = Request.Builder()
            .url("$baseUrl$endpoint")
            .header("Authorization", "Bearer $token")
            .post(bodyStr.toRequestBody(jsonMediaType))
            .build()

        client.newCall(req).execute().use { resp ->
            if (!resp.isSuccessful) return null
            val body = resp.body?.string() ?: return null
            return try {
                json.decodeFromString<DecideResult>(body)
            } catch (_: Exception) {
                null
            }
        }
    }

    fun setCheckpoint(workspace: String): Boolean {
        val map = mapOf("workspace" to workspace)
        val bodyStr = json.encodeToString(map)
        val req = Request.Builder()
            .url("$baseUrl/checkpoint/set")
            .header("Authorization", "Bearer $token")
            .post(bodyStr.toRequestBody(jsonMediaType))
            .build()

        return try {
            client.newCall(req).execute().use { it.isSuccessful }
        } catch (_: Exception) {
            false
        }
    }

    fun clearCheckpoint(workspace: String): Boolean {
        val map = mapOf("workspace" to workspace)
        val bodyStr = json.encodeToString(map)
        val req = Request.Builder()
            .url("$baseUrl/checkpoint/clear")
            .header("Authorization", "Bearer $token")
            .post(bodyStr.toRequestBody(jsonMediaType))
            .build()

        return try {
            client.newCall(req).execute().use { it.isSuccessful }
        } catch (_: Exception) {
            false
        }
    }
}
