package com.jtn.frigateviewer.data

import android.content.ContentProvider
import android.content.ContentValues
import android.database.Cursor
import android.net.Uri
import android.os.ParcelFileDescriptor
import android.provider.MediaStore
import androidx.test.core.app.ApplicationProvider
import java.io.File
import java.io.IOException
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.runBlocking
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.Robolectric
import org.robolectric.RobolectricTestRunner

/** Saving clips to the media store: a save that does not finish leaves nothing behind. */
@RunWith(RobolectricTestRunner::class)
class MediaFilesTest {
    private lateinit var media: FakeMediaStore
    private val files = AndroidMediaFiles(ApplicationProvider.getApplicationContext())

    @Before
    fun setUp() {
        media = Robolectric.setupContentProvider(FakeMediaStore::class.java, MediaStore.AUTHORITY)
    }

    private fun failedSave(failure: Throwable): Throwable? = runCatching {
        runBlocking {
            files.saveVideo("clip.mp4") { out ->
                out.write(1)
                throw failure
            }
        }
    }.exceptionOrNull()

    @Test
    fun aFinishedSaveIsPublished() {
        val uri = runBlocking { files.saveVideo("clip.mp4") { it.write(byteArrayOf(1, 2, 3)) } }
        assertEquals(media.inserted.single().toString(), uri)
        assertTrue(media.deleted.isEmpty())
        assertEquals(listOf(0), media.published)
    }

    @Test
    fun aFailedDownloadIsDeleted() {
        assertTrue(failedSave(IOException("dropped")) is IOException)
        assertEquals(media.inserted, media.deleted)
    }

    @Test
    fun aCancelledOrBrokenSaveIsDeletedToo() {
        assertTrue(failedSave(CancellationException("signed out")) is CancellationException)
        assertTrue(failedSave(IllegalStateException("bug")) is IllegalStateException)
        assertEquals(2, media.deleted.size)
        assertEquals(media.inserted, media.deleted)
        assertTrue("Nothing was published", media.published.isEmpty())
    }
}

/** Just enough of the media store for saving a video. */
class FakeMediaStore : ContentProvider() {
    val inserted = mutableListOf<Uri>()
    val deleted = mutableListOf<Uri>()

    /** The IS_PENDING value of each update. */
    val published = mutableListOf<Int>()

    override fun onCreate() = true

    override fun insert(uri: Uri, values: ContentValues?): Uri =
        Uri.withAppendedPath(uri, "${inserted.size + 1}").also { inserted += it }

    override fun openFile(uri: Uri, mode: String): ParcelFileDescriptor {
        val file = File.createTempFile("video", ".mp4").apply { deleteOnExit() }
        return ParcelFileDescriptor.open(file, ParcelFileDescriptor.parseMode(mode))
    }

    override fun delete(uri: Uri, selection: String?, selectionArgs: Array<out String>?): Int {
        deleted += uri
        return 1
    }

    override fun update(uri: Uri, values: ContentValues?, selection: String?, selectionArgs: Array<out String>?): Int {
        published += values?.getAsInteger(MediaStore.Video.Media.IS_PENDING) ?: -1
        return 1
    }

    override fun query(
        uri: Uri,
        projection: Array<out String>?,
        selection: String?,
        selectionArgs: Array<out String>?,
        sortOrder: String?,
    ): Cursor? = null

    override fun getType(uri: Uri): String = "video/mp4"
}
