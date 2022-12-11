/*
@author: liunice
@decription: Britbox UK iOS 外挂字幕和1080p画质解锁插件
@created: 2022-12-06
@updated: 2022-12-10
*/

/*
本插件与DualSubs字幕插件可能存在冲突，请按需启用。

项目主页: https://github.com/liunice/BritboxHelper
TG官方群: https://t.me/+W6aJJ-p9Ir1hNmY1
*/

(async () => {
    const $ = Env("britbox_helper.js")
    const SCRIPT_NAME = 'BritboxHelper'
    const SUBTITLES_DIR = 'Subtitles'
    const FN_TV_DB = 'DO_NOT_DELETE_britbox_tv.db'
    const FN_SHOW_DB = 'DO_NOT_DELETE_britbox_show.db'
    const TV_DB_THIN_DAYS = 3
    const FN_SUB_SYNCER_DB = 'sub_syncer.db'

    if (/magni\.itv\.com\/playlist\/britbox\/\w+/.test($request.url)) {
        let root = JSON.parse($request.body)
        root = {
            "variantAvailability": {
                "platformTag": "ctv",
                "featureset": [
                    "fairplay",
                    "inband-webvtt",
                    "hls",
                    "hd"
                ]
            },
            "device": {
                "id": root.device.id,
                "model": "AppleTV6,2",
                "manufacturer": "Apple",
                "type": "Apple TV 4K",
                "os": {
                    "name": "tvOS",
                    "version": "16.0"
                }
            },
            "client": {
                "id": "appletv-bb",
                "version": "3.11.81"
            },
            "user": root.user
        }
        $.done({ body: JSON.stringify(root)})
    }
    else if (/cdn\.britbox\.co\.uk\/api\/page\?.*?&path=\/(programme|series)\//.test($request.url)) {
        const root = JSON.parse($response.body)
        if (root.item.showId || root.item.show.type == 'show') {
            saveEpisodes(root)

            // disable cache
            let newHeaders = $response.headers
            delete newHeaders['X-Cache']
            delete newHeaders['ETag']
            delete newHeaders['Date']

            $.done({ headers: newHeaders, body: $response.body })
        }
        else {
            $.done({})
        }
    }
    else if (/isl\.britbox\.co\.uk\/api\/account\/items\/(\d+)\/videos\?/.test($request.url)) {
        const m = /isl\.britbox\.co\.uk\/api\/account\/items\/(\d+)\/videos\?/.exec($request.url)
        if (m) {
            // check playing episode
            const episode_id = m[1]
            $.log('playing episode: ' + episode_id)
            checkPlayingEpisode(episode_id)

            // create subtitle.conf if it's not there
            createConfFile()

            // // save current timestamp
            // $.setdata(new Date().getTime().toString(), `last_playing_ts@${SCRIPT_NAME}`)
        }
        $.done({})
    }
    else if (/(mobile|ctv)\.blue\.content\.britbox\.co\.uk\/.*?.webvtt$/.test($request.url)) {
        if (!checkSubtitleExists()) {
            $.done({})
            return
        }

        const offset = parseInt(getSubtitleConfig('offset') || '0')
        $.log(`offset = ${offset}`)

        // read srt content
        const srtBody = getSubtitle()

        // generate webvtt
        var vttBody = 'WEBVTT\r\n\r\n'
        let lines = srtBody.split('\r\n')
        // $.log(lines)
        for (const line of lines) {
            vttBody += line.replace(/\d{2}:\d{2}:\d{2}\,\d{3}/g, str => msToStr(strToMS(str) + offset)) + '\r\n'
        }
        $.log(vttBody)

        // return response
        var newHeaders = $request.headers
        newHeaders['Content-Type'] = 'application/vnd.apple.mpegurl'
        if ($.isQuanX()) {
            $.done({ body: vttBody, headers: newHeaders, status: 'HTTP/1.1 200 OK' })
        }
        else {
            $.done({ body: vttBody, headers: newHeaders, status: 200 })
        }
    }
    else if (/(mobile|ctv)\.blue\.content\.britbox\.co\.uk\/.*?\.ism\/\.m3u8\?/.test($request.url)) {
        let body = $response.body
        // force highest bitrate
        // #EXT-X-STREAM-INF:BANDWIDTH=3711000,CODECS="mp4a.40.2,avc1.4D4028",RESOLUTION=1280x720,FRAME-RATE=25,VIDEO-RANGE=SDR,AUDIO="audio-aacl-96",SUBTITLES="textstream",CLOSED-CAPTIONS=NONE
        const vcodecs = '(?:avc|hvc)'
        const bitrates = [...body.matchAll(RegExp(String.raw`#EXT-X-STREAM-INF:BANDWIDTH=(\d+),CODECS="[^"]+${vcodecs}[^"]+",RESOLUTION=([\dx]+).*?\s+.+`, 'g'))].map(s => parseInt(s[1]))
        const maxrate = Math.max(...bitrates)
        const m = RegExp(String.raw`#EXT-X-STREAM-INF:BANDWIDTH=(${maxrate}),CODECS="([^"]+${vcodecs}[^"]+)",RESOLUTION=([\dx]+).*?\s+(.+)`, 'g').exec(body)
        if (m) {
            body = body.replace(RegExp(String.raw`#EXT-X-STREAM-INF:BANDWIDTH=(?!${maxrate}).*?\s+.+`, 'g'), '')
            $.log(body)
            notify(SCRIPT_NAME, `已强制${m[3]}`, `BANDWIDTH=${numberWithCommas(m[1])},CODECS="${m[2]}"`)
        }

        // save manifest for sub syncer
        if (getSubtitleConfig('subsyncer.enabled') == 'true') {
            writeSubSyncerDB($request.url)
        }

        $.done({ body: body })
    }

    function saveEpisodes(root) {
        let series_name
        if (root.item.show) {
            // 1st season
            series_name = root.item.show.title
            writeShowDB(root.item.show.id, series_name)
        }
        else {
            // 2nd/3rd... season
            series_name = getShowName(root.item.showId)
            if (!series_name) {
                $.log(`未能从本地DB中查询到剧集名称: showId = ${root.item.showId}`)
                return
            }
        }

        const data = readTVDB()
        const ts = new Date().getTime()
        for (const ep of root.item['episodes']['items']) {
            const episode_id = ep['id']
            const season = root.item['seasonNumber'].toString().padStart(2, '0')
            const episode = ep['episodeNumber'].toString().padStart(2, '0')
            data[episode_id] = [series_name, season, episode, ts]
        }

        writeTVDB(data)
        $.log(`${root.item['episodes']['items'].length} episode(s) saved to db`)
    }

    function notify(title, subtitle, message) {
        const enabled = getScriptConfig('notify') || 'true'
        if (enabled.toLowerCase() == 'true') {
            $.msg(title, subtitle, message)
        }
    }

    function createConfFile() {
        const series_name = $.getdata(`series_name@${SCRIPT_NAME}`)
        const season = $.getdata(`season_no@${SCRIPT_NAME}`)
        if (!series_name) return

        const path = `${SUBTITLES_DIR}/${series_name}/S${season}/subtitle.conf`
        if (checkICloudExists(path)) return

        const content = `# Britbox所有视频默认需要将字幕后移10秒
offset=10000
subsyncer.enabled=false
        `
        writeICloud(path, content)
    }

    function getSubtitleConfig(key) {
        const series_name = $.getdata(`series_name@${SCRIPT_NAME}`)
        const season = $.getdata(`season_no@${SCRIPT_NAME}`)
        const episode = $.getdata(`ep_no@${SCRIPT_NAME}`)
        const confBody = readICloud(`${SUBTITLES_DIR}/${series_name}/S${season}/subtitle.conf`)
        if (!confBody) return null

        const m = new RegExp(String.raw`^\s*S${season}E${episode}:${key}\s*=\s*(.+)`, 'im').exec(confBody)
        if (m) {
            return m[1].trim()
        }
        else {
            const m0 = new RegExp(String.raw`^\s*${key}\s*=\s*(.+)`, 'im').exec(confBody)
            return m0 && m0[1].trim()
        }
    }

    function getScriptConfig(key) {
        const confBody = readICloud(`${SUBTITLES_DIR}/helper.conf`)
        if (!confBody) return null

        const m = new RegExp(String.raw`^\s*${key}\s*=\s*(.+)`, 'im').exec(confBody)
        return m && m[1].trim()
    }

    function checkPlayingEpisode(episode_id) {
        let root = readTVDB()
        const item = root[episode_id]
        if (item) {
            $.setdata(item[0], `series_name@${SCRIPT_NAME}`)
            $.setdata(item[1], `season_no@${SCRIPT_NAME}`)
            $.setdata(item[2], `ep_no@${SCRIPT_NAME}`)
            notify(SCRIPT_NAME, '正在播放剧集', `[${item[0]}] S${item[1]}E${item[2]}`)
        }
        else {
            clearPlaying()
        }
    }

    function clearPlaying() {
        $.setdata('', `series_name@${SCRIPT_NAME}`)
        $.setdata('', `season_no@${SCRIPT_NAME}`)
        $.setdata('', `ep_no@${SCRIPT_NAME}`)
    }

    function writeSubSyncerDB(manifest_url) {
        const series_name = $.getdata(`series_name@${SCRIPT_NAME}`)
        const season = $.getdata(`season_no@${SCRIPT_NAME}`)
        const episode = $.getdata(`ep_no@${SCRIPT_NAME}`)
        if (!series_name) return

        const path = `${SUBTITLES_DIR}/${series_name}/${FN_SUB_SYNCER_DB}`

        // read
        let root
        try {
            const body = readICloud(path)
            if (body) {
                root = JSON.parse(body)
            }
        }
        catch (e) {
            $.log(e)
        }
        if (!root) {
            root = { 'manifests': {} }
        }
        else if (root['manifests'][`S${season}E${episode}`]) {
            // 不进行覆盖，防止错误数据写入导致数据混乱
            return
        }

        // update
        root['manifests'][`S${season}E${episode}`] = manifest_url

        // write
        if (writeICloud(path, JSON.stringify(root))) {
            notify(SCRIPT_NAME, '播放记录已写入本地数据库', `[${series_name}] S${season}E${episode}`)
        }
    }

    function readTVDB() {
        let root
        try {
            const body = readICloud(`${SUBTITLES_DIR}/${FN_TV_DB}`)
            if (body) {
                root = JSON.parse(body)
            }
        }
        catch (e) {
            $.log(e)
        }
        return root || {}
    }

    function writeTVDB(data) {
        // remove old entries, make db file smaller
        const interval = 1000 * 3600 * 24 * TV_DB_THIN_DAYS
        const newData = Object.fromEntries(Object.entries(data).filter(
            ([_, info]) => new Date().getTime() - info[3] < interval)
        )

        // write to iCloud
        const path = `${SUBTITLES_DIR}/${FN_TV_DB}`
        writeICloud(path, JSON.stringify(newData))
    }

    function readShowDB() {
        let root
        try {
            const body = readICloud(`${SUBTITLES_DIR}/${FN_SHOW_DB}`)
            if (body) {
                root = JSON.parse(body)
            }
        }
        catch (e) {
            $.log(e)
        }
        return root || {}
    }

    function writeShowDB(showId, showName) {
        const data = readShowDB()
        data[showId] = showName

        // write to iCloud
        const path = `${SUBTITLES_DIR}/${FN_SHOW_DB}`
        writeICloud(path, JSON.stringify(data))
    }

    function getShowName(showId) {
        const data = readShowDB()
        return data && data[showId]
    }

    function numberWithCommas(x) {
        return x.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ",");
    }

    function msToStr(ms, webvtt = true) {
        // 00:00:10,120
        const hour = Math.floor(ms / (60 * 60 * 1000))
        const minutes = Math.floor((ms - hour * 60 * 60 * 1000) / (60 * 1000))
        const seconds = Math.floor((ms - hour * 60 * 60 * 1000 - minutes * 60 * 1000) / (1000))
        const milliseconds = ms % 1000
        return hour.toString().padStart(2, '0')
            + ':' + minutes.toString().padStart(2, '0')
            + ':' + seconds.toString().padStart(2, '0')
            + (webvtt ? '.' : ',') + milliseconds.toString().padStart(3, '0')
    }

    function strToMS(str, webvtt = false) {
        // 00:00:10,120
        const pts = str.split(webvtt ? '.' : ',')
        var ts = parseInt(pts[1])
        const parts = pts[0].split(':')
        for (const [i, val] of parts.entries()) {
            ts += 1000 * (60 ** (2 - i)) * parseInt(val);
        }
        return ts
    }

    function checkSubtitleExists() {
        const series_name = $.getdata(`series_name@${SCRIPT_NAME}`)
        if (!series_name) return false
        const season = $.getdata(`season_no@${SCRIPT_NAME}`)
        const episode = $.getdata(`ep_no@${SCRIPT_NAME}`)
        const path = `${SUBTITLES_DIR}/${series_name}/S${season}/S${season}E${episode}.srt`
        const found = checkICloudExists(path)
        if (!found) {
            $.log(`subtitle not exist: ${path}`)
        }
        return found
    }

    function getSubtitle() {
        const series_name = $.getdata(`series_name@${SCRIPT_NAME}`)
        const season = $.getdata(`season_no@${SCRIPT_NAME}`)
        const episode = $.getdata(`ep_no@${SCRIPT_NAME}`)
        const path = `${SUBTITLES_DIR}/${series_name}/S${season}/S${season}E${episode}.srt`
        return readICloud(path)
    }

    function readICloud(path) {
        const data = $iCloud.readFile(path)
        if (data === undefined) {
            $.log(`iCloud file read failed, path: ${path}`)
            return null
        }
        else {
            const content = new TextDecoder().decode(data)
            return content
        }
    }

    function writeICloud(path, content) {
        const buffer = new TextEncoder().encode(content)
        if (!$iCloud.writeFile(buffer, path)) {
            console.log(`iCloud file write failed, path: ${path}`)
            return false
        }
        return true
    }

    function checkICloudExists(path) {
        return $iCloud.readFile(path) !== undefined
    }

    // prettier-ignore
    /*********************************** BoxJS API *************************************/
    function Env(t, e) { class s { constructor(t) { this.env = t } send(t, e = "GET") { t = "string" == typeof t ? { url: t } : t; let s = this.get; return "POST" === e && (s = this.post), new Promise((e, i) => { s.call(this, t, (t, s, r) => { t ? i(t) : e(s) }) }) } get(t) { return this.send.call(this.env, t) } post(t) { return this.send.call(this.env, t, "POST") } } return new class { constructor(t, e) { this.name = t, this.http = new s(this), this.data = null, this.dataFile = "box.dat", this.logs = [], this.isMute = !1, this.isNeedRewrite = !1, this.logSeparator = "\n", this.encoding = "utf-8", this.startTime = (new Date).getTime(), Object.assign(this, e), this.log("", `🔔${this.name}, 开始!`) } isNode() { return "undefined" != typeof module && !!module.exports } isQuanX() { return "undefined" != typeof $task } isSurge() { return "undefined" != typeof $httpClient && "undefined" == typeof $loon } isLoon() { return "undefined" != typeof $loon } isShadowrocket() { return "undefined" != typeof $rocket } isStash() { return "undefined" != typeof $environment && $environment["stash-version"] } toObj(t, e = null) { try { return JSON.parse(t) } catch { return e } } toStr(t, e = null) { try { return JSON.stringify(t) } catch { return e } } getjson(t, e) { let s = e; const i = this.getdata(t); if (i) try { s = JSON.parse(this.getdata(t)) } catch { } return s } setjson(t, e) { try { return this.setdata(JSON.stringify(t), e) } catch { return !1 } } getScript(t) { return new Promise(e => { this.get({ url: t }, (t, s, i) => e(i)) }) } runScript(t, e) { return new Promise(s => { let i = this.getdata("@chavy_boxjs_userCfgs.httpapi"); i = i ? i.replace(/\n/g, "").trim() : i; let r = this.getdata("@chavy_boxjs_userCfgs.httpapi_timeout"); r = r ? 1 * r : 20, r = e && e.timeout ? e.timeout : r; const [o, n] = i.split("@"), a = { url: `http://${n}/v1/scripting/evaluate`, body: { script_text: t, mock_type: "cron", timeout: r }, headers: { "X-Key": o, Accept: "*/*" } }; this.post(a, (t, e, i) => s(i)) }).catch(t => this.logErr(t)) } loaddata() { if (!this.isNode()) return {}; { this.fs = this.fs ? this.fs : require("fs"), this.path = this.path ? this.path : require("path"); const t = this.path.resolve(this.dataFile), e = this.path.resolve(process.cwd(), this.dataFile), s = this.fs.existsSync(t), i = !s && this.fs.existsSync(e); if (!s && !i) return {}; { const i = s ? t : e; try { return JSON.parse(this.fs.readFileSync(i)) } catch (t) { return {} } } } } writedata() { if (this.isNode()) { this.fs = this.fs ? this.fs : require("fs"), this.path = this.path ? this.path : require("path"); const t = this.path.resolve(this.dataFile), e = this.path.resolve(process.cwd(), this.dataFile), s = this.fs.existsSync(t), i = !s && this.fs.existsSync(e), r = JSON.stringify(this.data); s ? this.fs.writeFileSync(t, r) : i ? this.fs.writeFileSync(e, r) : this.fs.writeFileSync(t, r) } } lodash_get(t, e, s) { const i = e.replace(/\[(\d+)\]/g, ".$1").split("."); let r = t; for (const t of i) if (r = Object(r)[t], void 0 === r) return s; return r } lodash_set(t, e, s) { return Object(t) !== t ? t : (Array.isArray(e) || (e = e.toString().match(/[^.[\]]+/g) || []), e.slice(0, -1).reduce((t, s, i) => Object(t[s]) === t[s] ? t[s] : t[s] = Math.abs(e[i + 1]) >> 0 == +e[i + 1] ? [] : {}, t)[e[e.length - 1]] = s, t) } getdata(t) { let e = this.getval(t); if (/^@/.test(t)) { const [, s, i] = /^@(.*?)\.(.*?)$/.exec(t), r = s ? this.getval(s) : ""; if (r) try { const t = JSON.parse(r); e = t ? this.lodash_get(t, i, "") : e } catch (t) { e = "" } } return e } setdata(t, e) { let s = !1; if (/^@/.test(e)) { const [, i, r] = /^@(.*?)\.(.*?)$/.exec(e), o = this.getval(i), n = i ? "null" === o ? null : o || "{}" : "{}"; try { const e = JSON.parse(n); this.lodash_set(e, r, t), s = this.setval(JSON.stringify(e), i) } catch (e) { const o = {}; this.lodash_set(o, r, t), s = this.setval(JSON.stringify(o), i) } } else s = this.setval(t, e); return s } getval(t) { return this.isSurge() || this.isLoon() ? $persistentStore.read(t) : this.isQuanX() ? $prefs.valueForKey(t) : this.isNode() ? (this.data = this.loaddata(), this.data[t]) : this.data && this.data[t] || null } setval(t, e) { return this.isSurge() || this.isLoon() ? $persistentStore.write(t, e) : this.isQuanX() ? $prefs.setValueForKey(t, e) : this.isNode() ? (this.data = this.loaddata(), this.data[e] = t, this.writedata(), !0) : this.data && this.data[e] || null } initGotEnv(t) { this.got = this.got ? this.got : require("got"), this.cktough = this.cktough ? this.cktough : require("tough-cookie"), this.ckjar = this.ckjar ? this.ckjar : new this.cktough.CookieJar, t && (t.headers = t.headers ? t.headers : {}, void 0 === t.headers.Cookie && void 0 === t.cookieJar && (t.cookieJar = this.ckjar)) } get(t, e = (() => { })) { if (t.headers && (delete t.headers["Content-Type"], delete t.headers["Content-Length"]), this.isSurge() || this.isLoon()) this.isSurge() && this.isNeedRewrite && (t.headers = t.headers || {}, Object.assign(t.headers, { "X-Surge-Skip-Scripting": !1 })), $httpClient.get(t, (t, s, i) => { !t && s && (s.body = i, s.statusCode = s.status ? s.status : s.statusCode, s.status = s.statusCode), e(t, s, i) }); else if (this.isQuanX()) this.isNeedRewrite && (t.opts = t.opts || {}, Object.assign(t.opts, { hints: !1 })), $task.fetch(t).then(t => { const { statusCode: s, statusCode: i, headers: r, body: o } = t; e(null, { status: s, statusCode: i, headers: r, body: o }, o) }, t => e(t && t.error || "UndefinedError")); else if (this.isNode()) { let s = require("iconv-lite"); this.initGotEnv(t), this.got(t).on("redirect", (t, e) => { try { if (t.headers["set-cookie"]) { const s = t.headers["set-cookie"].map(this.cktough.Cookie.parse).toString(); s && this.ckjar.setCookieSync(s, null), e.cookieJar = this.ckjar } } catch (t) { this.logErr(t) } }).then(t => { const { statusCode: i, statusCode: r, headers: o, rawBody: n } = t, a = s.decode(n, this.encoding); e(null, { status: i, statusCode: r, headers: o, rawBody: n, body: a }, a) }, t => { const { message: i, response: r } = t; e(i, r, r && s.decode(r.rawBody, this.encoding)) }) } } post(t, e = (() => { })) { const s = t.method ? t.method.toLocaleLowerCase() : "post"; if (t.body && t.headers && !t.headers["Content-Type"] && (t.headers["Content-Type"] = "application/x-www-form-urlencoded"), t.headers && delete t.headers["Content-Length"], this.isSurge() || this.isLoon()) this.isSurge() && this.isNeedRewrite && (t.headers = t.headers || {}, Object.assign(t.headers, { "X-Surge-Skip-Scripting": !1 })), $httpClient[s](t, (t, s, i) => { !t && s && (s.body = i, s.statusCode = s.status ? s.status : s.statusCode, s.status = s.statusCode), e(t, s, i) }); else if (this.isQuanX()) t.method = s, this.isNeedRewrite && (t.opts = t.opts || {}, Object.assign(t.opts, { hints: !1 })), $task.fetch(t).then(t => { const { statusCode: s, statusCode: i, headers: r, body: o } = t; e(null, { status: s, statusCode: i, headers: r, body: o }, o) }, t => e(t && t.error || "UndefinedError")); else if (this.isNode()) { let i = require("iconv-lite"); this.initGotEnv(t); const { url: r, ...o } = t; this.got[s](r, o).then(t => { const { statusCode: s, statusCode: r, headers: o, rawBody: n } = t, a = i.decode(n, this.encoding); e(null, { status: s, statusCode: r, headers: o, rawBody: n, body: a }, a) }, t => { const { message: s, response: r } = t; e(s, r, r && i.decode(r.rawBody, this.encoding)) }) } } time(t, e = null) { const s = e ? new Date(e) : new Date; let i = { "M+": s.getMonth() + 1, "d+": s.getDate(), "H+": s.getHours(), "m+": s.getMinutes(), "s+": s.getSeconds(), "q+": Math.floor((s.getMonth() + 3) / 3), S: s.getMilliseconds() }; /(y+)/.test(t) && (t = t.replace(RegExp.$1, (s.getFullYear() + "").substr(4 - RegExp.$1.length))); for (let e in i) new RegExp("(" + e + ")").test(t) && (t = t.replace(RegExp.$1, 1 == RegExp.$1.length ? i[e] : ("00" + i[e]).substr(("" + i[e]).length))); return t } queryStr(t) { let e = ""; for (const s in t) { let i = t[s]; null != i && "" !== i && ("object" == typeof i && (i = JSON.stringify(i)), e += `${s}=${i}&`) } return e = e.substring(0, e.length - 1), e } msg(e = t, s = "", i = "", r) { const o = t => { if (!t) return t; if ("string" == typeof t) return this.isLoon() ? t : this.isQuanX() ? { "open-url": t } : this.isSurge() ? { url: t } : void 0; if ("object" == typeof t) { if (this.isLoon()) { let e = t.openUrl || t.url || t["open-url"], s = t.mediaUrl || t["media-url"]; return { openUrl: e, mediaUrl: s } } if (this.isQuanX()) { let e = t["open-url"] || t.url || t.openUrl, s = t["media-url"] || t.mediaUrl, i = t["update-pasteboard"] || t.updatePasteboard; return { "open-url": e, "media-url": s, "update-pasteboard": i } } if (this.isSurge()) { let e = t.url || t.openUrl || t["open-url"]; return { url: e } } } }; if (this.isMute || (this.isSurge() || this.isLoon() ? $notification.post(e, s, i, o(r)) : this.isQuanX() && $notify(e, s, i, o(r))), !this.isMuteLog) { let t = ["", "==============📣系统通知📣=============="]; t.push(e), s && t.push(s), i && t.push(i), console.log(t.join("\n")), this.logs = this.logs.concat(t) } } log(...t) { t.length > 0 && (this.logs = [...this.logs, ...t]), console.log(t.join(this.logSeparator)) } logErr(t, e) { const s = !this.isSurge() && !this.isQuanX() && !this.isLoon(); s ? this.log("", `❗️${this.name}, 错误!`, t.stack) : this.log("", `❗️${this.name}, 错误!`, t) } wait(t) { return new Promise(e => setTimeout(e, t)) } done(t = {}) { const e = (new Date).getTime(), s = (e - this.startTime) / 1e3; this.log("", `🔔${this.name}, 结束! 🕛 ${s} 秒`), this.log(), this.isSurge() || this.isQuanX() || this.isLoon() ? $done(t) : this.isNode() && process.exit(1) } }(t, e) }
    /*****************************************************************************/
})()