package com.example;

/** Utility functions shared across the project. */
public class Util {

    /** Application configuration. */
    public static class AppConfig {
        public final String name;
        public final int port;
        public final boolean debug;

        public AppConfig(String name, int port, boolean debug) {
            this.name = name;
            this.port = port;
            this.debug = debug;
        }
    }

    /** Add two numbers. */
    public static int add(int a, int b) {
        return a + b;
    }

    /** Create a default configuration. */
    public static AppConfig defaultConfig() {
        return new AppConfig("app", 3000, false);
    }

    /** A helper for formatting strings with a prefix. */
    public static class StringHelper {
        private final String prefix;

        public StringHelper(String prefix) {
            this.prefix = prefix;
        }

        /** Format a value with the configured prefix. */
        public String format(String value) {
            return prefix + ": " + value;
        }
    }
}
