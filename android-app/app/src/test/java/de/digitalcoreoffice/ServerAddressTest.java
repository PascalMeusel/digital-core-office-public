package de.digitalcoreoffice;

import static org.junit.Assert.*;
import org.junit.Test;

public class ServerAddressTest {
    @Test public void normalizesDomainAndDefaultPort() {
        assertEquals("https://review.example.test", ServerAddress.normalize(" review.example.test/ "));
        assertEquals("https://example.org", ServerAddress.normalize("HTTPS://EXAMPLE.org:443/"));
        assertEquals("https://example.org:8443", ServerAddress.normalize("example.org:8443"));
        assertEquals("https://[::1]:8443", ServerAddress.normalize("https://[::1]:8443/"));
    }

    @Test public void rejectsUnsafeOrAmbiguousAddresses() {
        assertThrows(IllegalArgumentException.class, () -> ServerAddress.normalize("http://review.example.test"));
        assertThrows(IllegalArgumentException.class, () -> ServerAddress.normalize("https://user@example.org"));
        assertThrows(IllegalArgumentException.class, () -> ServerAddress.normalize("https://example.org/?x=1"));
        assertThrows(IllegalArgumentException.class, () -> ServerAddress.normalize("https://example.org/#login"));
        assertThrows(IllegalArgumentException.class, () -> ServerAddress.normalize("https://example.org:0"));
        assertThrows(IllegalArgumentException.class, () -> ServerAddress.normalize("https://example.org:65536"));
        assertThrows(IllegalArgumentException.class, () -> ServerAddress.normalize("https://example.org:"));
        assertThrows(IllegalArgumentException.class, () -> ServerAddress.normalize("javascript:alert(1)"));
        assertThrows(IllegalArgumentException.class, () -> ServerAddress.normalize(null));
        assertThrows(IllegalArgumentException.class, () -> ServerAddress.normalize("   "));
    }

    @Test public void rejectsPagePathsBecauseSuiteRequiresAnOrigin() {
        for (String path : new String[]{"/login", "/time/", "/office", "/%2f", "//"}) {
            assertThrows(IllegalArgumentException.class, () -> ServerAddress.normalize("https://example.org" + path));
        }
    }

    @Test public void limitsNavigationToConfiguredOrigin() {
        assertTrue(ServerAddress.belongsToServer("https://example.org", "https://example.org/inventory?search=1#stock"));
        assertTrue(ServerAddress.belongsToServer("https://example.org", "https://example.org:443/time"));
        assertTrue(ServerAddress.belongsToServer("https://example.org:8443", "https://example.org:8443/agile"));
        assertFalse(ServerAddress.belongsToServer("https://example.org", "https://example.org:8443"));
        assertFalse(ServerAddress.belongsToServer("https://example.org", "https://user@example.org"));
        assertFalse(ServerAddress.belongsToServer("https://example.org", "http://example.org"));
        assertFalse(ServerAddress.belongsToServer("https://example.org", "https://example.org.evil.test"));
        assertFalse(ServerAddress.belongsToServer("https://example.org", "https://evil.example"));
    }

    @Test public void probesOnlyTheChosenOrigin() {
        assertEquals("https://office.example.test/api/health", ServerAddress.healthUrl("office.example.test/"));
        assertEquals("https://example.org:8443", ServerAddress.origin("example.org:8443"));
    }
}
