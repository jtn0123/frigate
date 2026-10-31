package com.jtn.frigateviewer.data

import kotlinx.serialization.Serializable
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.jsonObject

/** Who is signed in, from `/api/profile`. Only an admin can change cameras. */
@Serializable
data class Profile(val username: String? = null, val role: String? = null) {
    val isAdmin: Boolean get() = role == "admin"
}

/** What a camera's motor can do, from `/api/<camera>/ptz/info`. */
data class PtzInfo(val canMove: Boolean, val canZoom: Boolean, val presets: List<String>) {
    val any: Boolean get() = canMove || canZoom || presets.isNotEmpty()
}

suspend fun FrigateApi.profile(): Profile = json.decodeFromString(getText(url("api/profile")))

suspend fun FrigateApi.ptzInfo(camera: String): PtzInfo {
    val root = json.parseToJsonElement(getText(url("api/$camera/ptz/info"))).jsonObject
    fun strings(key: String) = (root[key] as? JsonArray).orEmpty().mapNotNull { (it as? JsonPrimitive)?.contentOrNull }
    val features = strings("features")
    return PtzInfo(canMove = "pt" in features, canZoom = "zoom" in features, presets = strings("presets"))
}

/** Commands for `<camera>/ptz`; a move or zoom carries on until [STOP]. */
object Ptz {
    const val UP = "MOVE_UP"
    const val DOWN = "MOVE_DOWN"
    const val LEFT = "MOVE_LEFT"
    const val RIGHT = "MOVE_RIGHT"
    const val ZOOM_IN = "ZOOM_IN"
    const val ZOOM_OUT = "ZOOM_OUT"
    const val STOP = "STOP"

    fun preset(name: String) = "preset_$name"
}
