package com.jtn.frigateviewer.ui

import com.jtn.frigateviewer.data.Camera
import org.junit.Assert.assertEquals
import org.junit.Test

/** The grid plays each camera's lightest stream, as the config describes them, wherever it is listed. */
class LightStreamTest {
    private fun camera(vararg streams: Pair<String, String>, name: String = "garage", label: String = "Garage") =
        Camera(name, label, 0, true, mapOf(*streams), 0, 0)

    @Test
    fun aStreamNamedAsTheSubStreamWins() {
        assertEquals("garage_sub", lightStream(camera("Sub Stream" to "garage_sub", "Main Stream" to "garage")))
        assertEquals("garage_lq", lightStream(camera("Main" to "garage", "Phone" to "garage_lq", "Other" to "garage_alt")))
        // As go2rtc names are often written: "frontDoorSub" has "sub".
        assertEquals(
            "frontDoorSub",
            lightStream(camera("Phone" to "frontDoorSub", "Wall" to "front_door", name = "front_door", label = "Front door")),
        )
    }

    @Test
    fun theCamerasOwnNameSaysNothingOfAStream() {
        val lowGarage = camera("Main" to "low_garage", "Sub" to "low_garage_sub", name = "low_garage", label = "Low garage")

        assertEquals("low_garage_sub", lightStream(lowGarage))
    }

    @Test
    fun withoutANameTheLowestResolutionWins() {
        assertEquals(
            "drive_640x360",
            lightStream(camera("4K" to "drive_2160p", "Phone" to "drive_640x360", "Tablet" to "drive_720p")),
        )
    }

    @Test
    fun withoutAResolutionOneNotNamedAsTheMainStreamWins() {
        assertEquals("porch_alt", lightStream(camera("Main" to "porch", "Other" to "porch_alt", "High" to "porch_hq")))
    }

    @Test
    fun withNothingToTellThemApartTheLastWins() {
        assertEquals("yard_b", lightStream(camera("One" to "yard_a", "Two" to "yard_b")))
        assertEquals("yard_hd", lightStream(camera("Main" to "yard_main", "HD" to "yard_hd")))
    }

    @Test
    fun withoutStreamsTheCamerasName() {
        assertEquals("garage", lightStream(camera()))
    }
}
