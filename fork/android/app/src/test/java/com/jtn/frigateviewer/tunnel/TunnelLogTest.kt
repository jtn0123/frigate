package com.jtn.frigateviewer.tunnel

import org.junit.Assert.assertEquals
import org.junit.Test

class TunnelLogTest {
    @Test
    fun theLogCanBeReadWhileTheTunnelWritesToIt() {
        val log = TunnelLog(capacity = 50, repeatMs = 0)
        val writer = Thread { repeat(20_000) { log.add("line $it") } }
        writer.start()
        // Walking the entries while another thread adds and trims them must
        // not fail, as when the report is built while the tunnel is logging.
        while (writer.isAlive) {
            log.entries.forEach { it.text.length }
        }
        writer.join()
        assertEquals("line 19999", log.entries.last().text)
    }
}
