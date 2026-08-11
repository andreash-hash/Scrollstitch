/**
 * Push registration for "tell me when the stitch is done".
 *
 * A local notification cannot do this job. iOS suspends JavaScript within
 * seconds of the app going to the background, so the client is not running to
 * notice that the server finished — which is precisely the moment the user
 * wants to hear about. The completion notice therefore has to come *from* the
 * server, addressed to a token this device registered up front.
 *
 * Everything here is best-effort. A denied permission, a simulator, or a
 * missing APNs key must never stop someone from stitching a screenshot, so all
 * failures resolve to null and the caller carries on without a notification.
 */
import * as Notifications from "expo-notifications";
import * as Device from "expo-device";
import Constants from "expo-constants";
import { Platform } from "react-native";

/** Show an alert even when the app happens to be open when the push lands. */
Notifications.setNotificationHandler({
  handleNotification: async () => ({
    shouldShowBanner: true,
    shouldShowList: true,
    shouldPlaySound: true,
    shouldSetBadge: false,
  }),
});

let cachedToken: string | null = null;
let asked = false;

/**
 * Ask for permission and return an Expo push token, or null.
 *
 * Safe to call repeatedly: the permission prompt is only ever raised once, and
 * the token is cached for the session.
 */
export async function getPushToken(): Promise<string | null> {
  if (cachedToken) return cachedToken;
  // Remote push is not delivered to simulators, and never to web here.
  if (Platform.OS === "web" || !Device.isDevice) return null;

  try {
    if (Platform.OS === "android") {
      // Android needs a channel before anything will be shown.
      await Notifications.setNotificationChannelAsync("stitch-complete", {
        name: "Stitch complete",
        importance: Notifications.AndroidImportance.DEFAULT,
        vibrationPattern: [0, 250, 250, 250],
        lightColor: "#ec3013",
      });
    }

    const existing = await Notifications.getPermissionsAsync();
    let status = existing.status;
    if (status !== "granted") {
      // Only ever prompt once per launch — a user who said no should not be
      // asked again every time they stitch.
      if (asked) return null;
      asked = true;
      status = (await Notifications.requestPermissionsAsync()).status;
    }
    if (status !== "granted") return null;

    const projectId =
      Constants.expoConfig?.extra?.eas?.projectId ?? Constants.easConfig?.projectId;
    if (!projectId) {
      // Written into app.json by `eas init` / the first EAS build. Without it
      // Expo cannot mint a token, so say which step is missing rather than
      // reporting a generic failure.
      console.log(
        "Push disabled: no EAS projectId in app.json (extra.eas.projectId). Run `eas init`."
      );
      return null;
    }
    const token = await Notifications.getExpoPushTokenAsync({ projectId });
    cachedToken = token.data;
    return cachedToken;
  } catch (err) {
    console.log("Push registration unavailable:", err);
    return null;
  }
}

/** True once the user has granted permission — drives the "you can leave" hint. */
export async function hasPushPermission(): Promise<boolean> {
  if (Platform.OS === "web" || !Device.isDevice) return false;
  try {
    const { status } = await Notifications.getPermissionsAsync();
    return status === "granted";
  } catch {
    return false;
  }
}
