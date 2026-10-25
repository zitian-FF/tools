import Toybox.Lang;
import Toybox.WatchUi;

// The eight girls, in rotation order (from the design handoff's manifest).
module Roster {

    const IDS = ["gemma", "gptee", "claudia", "d_seeker", "myuse", "roxxy", "kimi", "cid"];

    const ACCENTS = [0xBCA3FF, 0xE33152, 0xE7AF55, 0x426CEB, 0xAE6AE8, 0xE96E5D, 0x3B80FF, 0x4AD4CE];

    function count() as Number {
        return IDS.size();
    }

    function portrait(i as Number) as WatchUi.BitmapResource {
        var res = [
            Rez.Drawables.P_gemma, Rez.Drawables.P_gptee, Rez.Drawables.P_claudia,
            Rez.Drawables.P_d_seeker, Rez.Drawables.P_myuse, Rez.Drawables.P_roxxy,
            Rez.Drawables.P_kimi, Rez.Drawables.P_cid
        ];
        return WatchUi.loadResource(res[i]) as WatchUi.BitmapResource;
    }

    function indexOf(id as String) as Number {
        for (var i = 0; i < IDS.size(); i++) {
            if (IDS[i].equals(id)) {
                return i;
            }
        }
        return -1;
    }
}
