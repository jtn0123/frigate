package com.jtn.frigateviewer.data

import android.content.ContentValues
import android.content.Context
import android.net.Uri
import android.provider.MediaStore
import androidx.core.content.FileProvider
import java.io.File
import java.io.IOException
import java.io.OutputStream
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.NonCancellable
import kotlinx.coroutines.withContext

/** Where clips and snapshots go on the phone; an interface so tests need no media store. */
interface MediaFiles {
    /** Saves a video to Movies/Frigate, where the gallery finds it, and returns its `content://` URI. */
    suspend fun saveVideo(name: String, write: suspend (OutputStream) -> Unit): String

    /** Puts [bytes] where other apps can be handed them to share, and returns its `content://` URI. */
    suspend fun shareable(name: String, bytes: ByteArray): String
}

class AndroidMediaFiles(private val context: Context) : MediaFiles {
    override suspend fun saveVideo(name: String, write: suspend (OutputStream) -> Unit): String {
        val resolver = context.contentResolver
        val uri = newPendingVideo(name)
        var written = false
        try {
            withContext(Dispatchers.IO) {
                resolver.openOutputStream(uri)?.use { write(it) } ?: throw IOException("Could not save to Movies")
            }
            written = true
        } finally {
            // Whatever stopped it, cancelling included: a pending entry left behind is an orphan file.
            if (!written) withContext(NonCancellable + Dispatchers.IO) { resolver.delete(uri, null, null) }
        }
        val done = ContentValues().apply { put(MediaStore.Video.Media.IS_PENDING, 0) }
        withContext(Dispatchers.IO) { resolver.update(uri, done, null, null) }
        return uri.toString()
    }

    /** An empty video in Movies/Frigate, hidden from the gallery until it is written. */
    private suspend fun newPendingVideo(name: String): Uri {
        val values = ContentValues().apply {
            put(MediaStore.Video.Media.DISPLAY_NAME, name)
            put(MediaStore.Video.Media.MIME_TYPE, "video/mp4")
            put(MediaStore.Video.Media.RELATIVE_PATH, "Movies/Frigate")
            put(MediaStore.Video.Media.IS_PENDING, 1)
        }
        return withContext(Dispatchers.IO) { context.contentResolver.insert(MediaStore.Video.Media.EXTERNAL_CONTENT_URI, values) }
            ?: throw IOException("Could not save to Movies")
    }

    override suspend fun shareable(name: String, bytes: ByteArray): String = withContext(Dispatchers.IO) {
        // Only the latest share is kept; the cache is cleared rather than growing.
        val dir = File(context.cacheDir, SHARED_DIR).apply {
            deleteRecursively()
            mkdirs()
        }
        val file = File(dir, name).apply { writeBytes(bytes) }
        FileProvider.getUriForFile(context, "${context.packageName}.files", file).toString()
    }

    private companion object {
        const val SHARED_DIR = "shared"
    }
}
