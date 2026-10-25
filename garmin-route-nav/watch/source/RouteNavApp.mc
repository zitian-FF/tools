import Toybox.Application;
import Toybox.Lang;
import Toybox.WatchUi;

class RouteNavApp extends Application.AppBase {

    function initialize() {
        AppBase.initialize();
    }

    function getInitialView() {
        return [new HomeView(), new HomeDelegate()];
    }

    function onStop(state as Dictionary?) as Void {
        Nav.shutdown();
    }

    function onSettingsChanged() as Void {
        WatchUi.requestUpdate();
    }
}
