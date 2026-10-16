#include <WiFi.h>
#include <HTTPClient.h>
#include <ArduinoJson.h>

// Replace with your Wi-Fi credentials
const char *SSID = "YOUR_WIFI_SSID";
const char *PASSWORD = "YOUR_WIFI_PASSWORD";

// Gateway endpoint
const char *GATEWAY_BASE = "http://raspberrypi.local:8080";

// Device metadata
const char *DEVICE_ADDRESS = "0x0000000000000000000000000000000000000000"; // replace with device wallet address
const char *OBJECT_ADDRESS = "0x0000000000000000000000000000000000000000"; // resource owner address
const char *ACCESS_TYPE = "TEMPERATURE";

unsigned long lastRequest = 0;
const unsigned long intervalMs = 10000;

void setup() {
  Serial.begin(115200);
  WiFi.begin(SSID, PASSWORD);

  Serial.print("Connecting to Wi-Fi");
  while (WiFi.status() != WL_CONNECTED) {
    delay(500);
    Serial.print(".");
  }
  Serial.println();
  Serial.println("Wi-Fi connected");
}

bool evaluateAccess(const char *resource, const char *action) {
  HTTPClient http;
  String url = String(GATEWAY_BASE) + "/evaluate-access";
  http.begin(url);
  http.addHeader("Content-Type", "application/json");

  StaticJsonDocument<256> payload;
  payload["subjectAddress"] = DEVICE_ADDRESS;
  payload["objectAddress"] = OBJECT_ADDRESS;
  payload["accType"] = ACCESS_TYPE;
  payload["resource"] = resource;
  payload["action"] = action;

  String body;
  serializeJson(payload, body);

  int httpCode = http.POST(body);
  if (httpCode <= 0) {
    Serial.printf("HTTP error: %s\n", http.errorToString(httpCode).c_str());
    http.end();
    return false;
  }

  String response = http.getString();
  http.end();

  StaticJsonDocument<256> doc;
  DeserializationError err = deserializeJson(doc, response);
  if (err) {
    Serial.println("Failed to parse JSON");
    return false;
  }

  if (doc["status"] != "ok") {
    Serial.printf("Gateway rejected request: %s\n", doc["message"].as<const char *>());
    return false;
  }

  bool allowed = doc["allowed"];
  Serial.printf("Access %s\n", allowed ? "granted" : "denied");
  return allowed;
}

void loop() {
  if (WiFi.status() != WL_CONNECTED) {
    Serial.println("Wi-Fi disconnected, reconnecting...");
    WiFi.reconnect();
    delay(1000);
    return;
  }

  unsigned long now = millis();
  if (now - lastRequest >= intervalMs) {
    lastRequest = now;

    if (evaluateAccess("sensor.data", "view")) {
      // Replace this with the actual sensing logic
      float reading = 21.5; // example payload
      Serial.printf("Publishing reading: %.2f\n", reading);
      // TODO: publish to MQTT/topic or send to primary group head
    }
  }

  delay(100);
}
