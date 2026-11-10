package de.digitalcoreoffice;

import static org.junit.Assert.*;
import java.io.File;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.util.Base64;
import org.junit.Test;

public class NativeExportTest {
    @Test public void savesExactUtf8BytesAcrossChunksAndCleansTemporaryCopy() throws Exception {
        File directory = Files.createTempDirectory("dco-export-test-").toFile();
        byte[] first = "Name;Quantity\r\nMünchen;".getBytes(StandardCharsets.UTF_8);
        byte[] second = "42\r\n".getBytes(StandardCharsets.UTF_8);
        NativeExport export = new NativeExport(directory,"inventory.csv","text/csv",first.length + second.length);
        File temporary = export.file;
        try {
            export.append(0,Base64.getEncoder().encodeToString(first));
            export.append(1,Base64.getEncoder().encodeToString(second));
            export.finish(); assertTrue(export.isReady());
            assertEquals("Name;Quantity\r\nMünchen;42\r\n",new String(Files.readAllBytes(temporary.toPath()),StandardCharsets.UTF_8));
        } finally {export.close();directory.delete();}
        assertFalse(temporary.exists());
    }
    @Test public void rejectsOverLimitIncompleteAndReorderedExports() throws Exception {
        File directory = Files.createTempDirectory("dco-export-test-").toFile();
        try {
            assertThrows(IllegalArgumentException.class,()->new NativeExport(directory,"x","text/plain",NativeExport.MAX_BYTES+1));
            try (NativeExport export = new NativeExport(directory,"x","text/plain",3)) {
                assertThrows(IllegalArgumentException.class,()->export.append(1,"YQ=="));
                assertThrows(IllegalArgumentException.class,export::finish);
                assertThrows(IllegalArgumentException.class,()->export.append(0,"YWJjZA=="));
                assertThrows(IllegalArgumentException.class,()->export.append(0,"!invalid"));
            }
        } finally {directory.delete();}
    }
    @Test public void neverUsesTheUntrustedFilenameAsAPath() {
        assertEquals("_.._report.csv",NativeExport.safeFilename("../../report.csv"));
        assertFalse(NativeExport.safeFilename("C:\\private\\report.csv").contains("\\"));
        assertEquals("digital-core-office-export.bin",NativeExport.safeFilename(".."));
    }
}
