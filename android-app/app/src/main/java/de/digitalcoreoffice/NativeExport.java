package de.digitalcoreoffice;

import java.io.Closeable;
import java.io.File;
import java.io.FileOutputStream;
import java.io.IOException;
import java.util.Base64;
import java.util.UUID;

/** A bounded temporary export; website filenames are never used as filesystem paths. */
final class NativeExport implements Closeable {
    static final long MAX_BYTES = 20L * 1024 * 1024;
    static final int MAX_CHUNK_CHARS = 256 * 1024;
    final String id = UUID.randomUUID().toString();
    final String filename;
    final String mimeType;
    final File file;
    final long expectedBytes;
    private FileOutputStream output;
    private long written;
    private int nextSequence;
    private boolean ready;

    NativeExport(File cacheDirectory, String name, String mime, long size) throws IOException {
        if (size < 0 || size > MAX_BYTES) throw new IllegalArgumentException("Export must be no larger than 20 MB.");
        filename = safeFilename(name);
        mimeType = mime != null && mime.matches("[A-Za-z0-9!#$&^_.+-]+/[A-Za-z0-9!#$&^_.+-]+") ? mime : "application/octet-stream";
        expectedBytes = size;
        file = File.createTempFile("dco-export-", ".tmp", cacheDirectory);
        output = new FileOutputStream(file);
    }

    private NativeExport(File savedFile, String name, String mime) {
        file = savedFile; filename = safeFilename(name); mimeType = mime;
        expectedBytes = savedFile.length(); written = expectedBytes; ready = true;
    }

    static NativeExport restore(File cacheDirectory, String path, String name, String mime) throws IOException {
        File saved = new File(path).getCanonicalFile();
        if (!cacheDirectory.getCanonicalFile().equals(saved.getParentFile()) || !saved.getName().startsWith("dco-export-") || !saved.isFile() || saved.length() > MAX_BYTES) throw new IOException("Invalid saved export.");
        return new NativeExport(saved, name, mime);
    }

    void append(int sequence, String encoded) throws IOException {
        if (ready || output == null || sequence != nextSequence) throw new IllegalArgumentException("Export chunks arrived out of order.");
        if (encoded == null || encoded.length() > MAX_CHUNK_CHARS) throw new IllegalArgumentException("Export chunk is too large.");
        byte[] bytes = Base64.getDecoder().decode(encoded);
        if (written + bytes.length > expectedBytes || written + bytes.length > MAX_BYTES) throw new IllegalArgumentException("Export exceeds its declared size.");
        output.write(bytes);
        written += bytes.length;
        nextSequence++;
    }

    void finish() throws IOException {
        if (ready || written != expectedBytes || output == null) throw new IllegalArgumentException("Export is incomplete.");
        output.flush(); output.close(); output = null; ready = true;
    }

    boolean isReady() { return ready; }

    @Override public void close() {
        if (output != null) { try { output.close(); } catch (IOException ignored) {} output = null; }
        if (file.exists()) file.delete();
    }

    static String safeFilename(String name) {
        String cleaned = name == null ? "" : name.replaceAll("[\\\\/\\p{Cntrl}]", "_").replaceAll("^\\.+", "").trim();
        if (cleaned.isEmpty()) return "digital-core-office-export.bin";
        return cleaned.length() > 180 ? cleaned.substring(cleaned.length() - 180) : cleaned;
    }
}
