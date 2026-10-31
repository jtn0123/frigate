package com.jtn.frigateviewer.data

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.doubleOrNull
import kotlinx.serialization.json.jsonObject

/** How the server is doing, from `/api/stats`. Anything an older Frigate leaves out is null or empty. */
data class ServerStats(
    val uptimeSeconds: Long?,
    val version: String?,
    /** The newest release, when the server checks for one. */
    val latestVersion: String?,
    /** Whole-system CPU and memory use, in percent. */
    val cpuPercent: Double?,
    val memoryPercent: Double?,
    val gpus: List<GpuStats>,
    val detectors: List<DetectorStats>,
    val cameras: List<CameraStats>,
    val storage: List<StorageStats>,
)

data class GpuStats(val name: String, val usagePercent: Double?, val memoryPercent: Double?)

data class DetectorStats(val name: String, val inferenceMs: Double?)

/** Frames per second coming from the camera, run through detection, and dropped. */
data class CameraStats(
    val name: String,
    val cameraFps: Double,
    val processFps: Double,
    val skippedFps: Double,
    val detectionFps: Double,
    val detectionEnabled: Boolean,
)

/** One mount the server records to; sizes in MiB. */
data class StorageStats(val mount: String, val totalMb: Double, val usedMb: Double) {
    val usedFraction: Float get() = if (totalMb > 0) (usedMb / totalMb).toFloat().coerceIn(0f, 1f) else 0f
}

/** Reads `/api/stats`, where usages are strings such as "12.0%" and some fields are missing on older servers. */
fun parseStats(statsJson: String): ServerStats {
    val root = Json.parseToJsonElement(statsJson).jsonObject
    val service = root.obj("service")
    val system = root.obj("cpu_usages")?.obj("frigate.full_system")
    return ServerStats(
        uptimeSeconds = service?.get("uptime").number()?.toLong(),
        version = service?.get("version").text(),
        latestVersion = service?.get("latest_version").text()?.takeIf { it != "disabled" && it != "unknown" },
        cpuPercent = system?.get("cpu").number(),
        memoryPercent = system?.get("mem").number(),
        gpus = root.obj("gpu_usages").entries { name, gpu ->
            GpuStats(name, gpu["gpu"].number(), gpu["mem"].number())
        },
        detectors = root.obj("detectors").entries { name, detector ->
            DetectorStats(name, detector["inference_speed"].number())
        },
        cameras = root.obj("cameras").entries { name, camera ->
            CameraStats(
                name = name,
                cameraFps = camera["camera_fps"].number() ?: 0.0,
                processFps = camera["process_fps"].number() ?: 0.0,
                skippedFps = camera["skipped_fps"].number() ?: 0.0,
                detectionFps = camera["detection_fps"].number() ?: 0.0,
                detectionEnabled = (camera["detection_enabled"] as? JsonPrimitive)?.let { it.booleanOrNull ?: (it.doubleOrNull != 0.0) }
                    ?: true,
            )
        },
        storage = service?.obj("storage").entries { mount, disk ->
            StorageStats(mount, disk["total"].number() ?: 0.0, disk["used"].number() ?: 0.0)
        }.filter { it.totalMb > 0 },
    )
}

/** Whether release [latest] is newer than [current], comparing only "0.17.1" and ignoring build suffixes. */
fun isNewerRelease(latest: String, current: String): Boolean {
    fun parts(version: String) = version.substringBefore('-').split('.').map { it.toIntOrNull() ?: 0 }
    val a = parts(latest)
    val b = parts(current)
    for (i in 0 until maxOf(a.size, b.size)) {
        val diff = a.getOrElse(i) { 0 } - b.getOrElse(i) { 0 }
        if (diff != 0) return diff > 0
    }
    return false
}

private fun JsonObject.obj(key: String): JsonObject? = this[key] as? JsonObject

private fun <T> JsonObject?.entries(read: (String, JsonObject) -> T): List<T> =
    this?.mapNotNull { (name, value) -> (value as? JsonObject)?.let { read(name, it) } }.orEmpty()

private fun JsonElement?.text(): String? = (this as? JsonPrimitive)?.contentOrNull?.takeIf { it.isNotBlank() }

/** A number, or a string holding one such as "12.0%" or "3.4". */
private fun JsonElement?.number(): Double? = text()?.trim()?.removeSuffix("%")?.trim()?.toDoubleOrNull()
