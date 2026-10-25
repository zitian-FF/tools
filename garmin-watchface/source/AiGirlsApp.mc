import Toybox.Application;
import Toybox.Lang;
import Toybox.WatchUi;

class AiGirlsApp extends Application.AppBase {

    private var _view as FaceView or Null;

    function initialize() {
        AppBase.initialize();
    }

    function getInitialView() {
        var view = new FaceView();
        _view = view;
        return [view];
    }

    function onSettingsChanged() as Void {
        if (_view != null) {
            (_view as FaceView).loadSettings();
        }
        WatchUi.requestUpdate();
    }
}
