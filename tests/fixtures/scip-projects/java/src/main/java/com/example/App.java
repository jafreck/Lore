package com.example;

import com.example.Util.AppConfig;
import com.example.Util.StringHelper;

/** Main application entry point. */
public class App {

    /** Initialize and run the application. */
    public static void main(String[] args) {
        AppConfig config = Util.defaultConfig();
        int result = Util.add(config.port, 1);
        StringHelper helper = new StringHelper("App");
        System.out.println(helper.format("running on port " + result));
    }

    /** Process a list of items. */
    public static int processItems(String[] items) {
        int total = 0;
        for (String item : items) {
            total = Util.add(total, item.length());
        }
        return total;
    }
}
