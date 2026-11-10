package de.digitalcoreoffice;

import java.net.URI;
import java.net.URISyntaxException;
import java.util.Locale;

public final class ServerAddress {
    private ServerAddress() {}

    public static String normalize(String input) {
        String candidate = input == null ? "" : input.trim();
        if (candidate.isEmpty()) throw new IllegalArgumentException("Enter a server address.");
        if (!candidate.contains("://")) candidate = "https://" + candidate;
        try {
            URI uri = new URI(candidate);
            if (!"https".equalsIgnoreCase(uri.getScheme())) throw new IllegalArgumentException("The server must use HTTPS.");
            if (uri.getHost() == null || uri.getHost().isBlank()) throw new IllegalArgumentException("Enter a valid server name.");
            if (uri.getUserInfo() != null || uri.getQuery() != null || uri.getFragment() != null) {
                throw new IllegalArgumentException("Use only the server address, without login, query or fragment.");
            }
            int port = uri.getPort();
            if (port < -1 || port == 0 || port > 65535 || uri.getRawAuthority().endsWith(":")) {
                throw new IllegalArgumentException("Enter a valid server port.");
            }
            String authority = uri.getHost().toLowerCase(Locale.ROOT) + (port == -1 || port == 443 ? "" : ":" + port);
            String path = uri.getRawPath();
            if (path != null && !path.isEmpty() && !path.equals("/")) {
                throw new IllegalArgumentException("Use the server address without a page path.");
            }
            return "https://" + authority;
        } catch (URISyntaxException exception) {
            throw new IllegalArgumentException("Enter a valid server address.", exception);
        }
    }

    public static String healthUrl(String baseUrl) {
        return normalize(baseUrl) + "/api/health";
    }

    public static String origin(String baseUrl) {
        try {
            URI uri = new URI(normalize(baseUrl));
            return "https://" + uri.getAuthority();
        } catch (URISyntaxException exception) {
            throw new IllegalArgumentException(exception);
        }
    }

    public static boolean belongsToServer(String baseUrl, String candidateUrl) {
        try {
            URI base = new URI(normalize(baseUrl));
            URI candidate = new URI(candidateUrl);
            if (!base.getScheme().equalsIgnoreCase(candidate.getScheme()) || !base.getHost().equalsIgnoreCase(candidate.getHost())) return false;
            if (candidate.getUserInfo() != null) return false;
            int candidatePort = candidate.getPort() == 443 ? -1 : candidate.getPort();
            return base.getPort() == candidatePort;
        } catch (Exception ignored) {
            return false;
        }
    }
}
