package com.jtn.frigateviewer.data

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class StatsTest {
    private val stats = parseStats(javaClass.classLoader!!.getResource("stats.json")!!.readText())

    @Test
    fun readsTheServiceAndSystemFigures() {
        assertEquals(273_600L, stats.uptimeSeconds)
        assertEquals("0.17.0-abc123", stats.version)
        assertEquals("0.17.1", stats.latestVersion)
        assertEquals(23.5, stats.cpuPercent!!, 0.0)
        assertEquals(41.2, stats.memoryPercent!!, 0.0)
    }

    @Test
    fun readsPercentStringsAndLeavesOutWhatIsNotANumber() {
        val gpu = stats.gpus.single()
        assertEquals("intel-qsv", gpu.name)
        assertEquals(12.0, gpu.usagePercent!!, 0.0)
        assertNull("\"-%\" is no figure", gpu.memoryPercent)
    }

    @Test
    fun readsDetectorsAndEachCamerasFrameRates() {
        assertEquals(8.42, stats.detectors.single().inferenceMs!!, 0.0)
        val driveway = stats.cameras.first { it.name == "driveway" }
        assertEquals(5.1, driveway.cameraFps, 0.0)
        assertEquals(5.0, driveway.processFps, 0.0)
        assertTrue(driveway.detectionEnabled)
        assertFalse(stats.cameras.first { it.name == "garage" }.detectionEnabled)
    }

    @Test
    fun keepsOnlyMountsWithASize() {
        assertEquals(listOf("/media/frigate/recordings", "/dev/shm"), stats.storage.map { it.mount })
        assertEquals(0.9023f, stats.storage.first().usedFraction, 0.001f)
    }

    @Test
    fun anOlderServerWithFewFieldsStillParses() {
        val old = parseStats("""{"service": {"uptime": 60}, "detectors": {}, "cameras": {"a": {"camera_fps": 5}}}""")
        assertEquals(60L, old.uptimeSeconds)
        assertNull(old.cpuPercent)
        assertTrue(old.cameras.single().detectionEnabled)
        assertTrue(old.storage.isEmpty())
    }
}
