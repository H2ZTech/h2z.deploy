# Device library digest (basis for discovery)

This is a digest of the product device library, to help you identify devices and choose read-only query methods. It is a lead, not a conclusion:

- Every entry carries an evidence level. Interfaces marked "candidate, unverified" may differ from real devices; treat what they return as unconfirmed, and do not keep retrying what cannot be read.
- Devices not in the library are classified from evidence as usual; write unknown if you cannot identify them.
- This digest contains no account passwords. Use only the read-only handles given by the operator; if there are none, register ACTION_REQUIRED and do not guess default values.
- Query only. The commands and interfaces listed below are read-only; do not run a command that is not listed here just because it "looks like a query".

## 1. Network devices: how to identify them

Read `sysObjectID` (1.3.6.1.2.1.1.2.0) first: the enterprise number in `1.3.6.1.4.1.<enterprise number>...` maps to the vendor; then confirm with the wording in `sysDescr` and the SSH banner.

| Platform | Enterprise number | sysDescr wording | SSH banner | Roles |
|---|---|---|---|---|
| H3C Comware 7 (`h3c-comware`) | 25506 | H3C Comware Platform Software / HPE Comware Platform Software | SSH-2.0-Comware | switch, router, ac, ap |
| Cisco IOS / IOS XE (`cisco-ios`) | 9 | Cisco IOS Software / Cisco IOS XE Software | SSH-2.0-Cisco | switch, router |
| Huawei VRP (`huawei-vrp`) | 2011 | Huawei Versatile Routing Platform / HUAWEI | SSH-2.0-HUAWEI | switch, router, ac, ap |
| HPE Aruba AOS-CX / ArubaOS-Switch (`aruba-aoscx`) | 47196, 11, 14823 | Aruba / ArubaOS / ProCurve | — | switch, ac, ap |
| Ruijie RGOS / Reyee (`ruijie-rgos`) | 4881 | Ruijie / RGOS | — | switch, router, ac, ap |
| Juniper Junos (`juniper-junos`) | 2636 | Juniper Networks / JUNOS | — | switch, router, firewall |
| MikroTik RouterOS (`mikrotik-routeros`) | 14988 | RouterOS | — | router, switch, ap |
| Fortinet FortiOS (`fortinet-fortios`) | 12356 | FortiGate / FortiSwitch / FortiAP | — | firewall, router, switch, ap |
| Ubiquiti UniFi (`ubiquiti-unifi`) | 41112 | UniFi / USW- / UAP / U6- / UDM | — | router, switch, ap |
| TP-Link Omada / JetStream (`tplink-omada`) | 11863 | JetStream / Omada / TL-SG / EAP | — | router, switch, ap |
| APC / Schneider UPS network card (`apc-ups`) | 318 | APC Web/SNMP Management Card | — | ups |
| Anything else that answers standard SNMP (`generic-snmp`) | 8072, 4526, 171, 1916, 30065, 25461, 29671, 890, 674, 534, 3808 | — | — | switch, router, firewall, ap, ups, host |

Other enterprise numbers: 171 = D-Link; 534 = Eaton; 674 = Dell; 890 = Zyxel; 1916 = Extreme Networks; 3808 = CyberPower; 4526 = Netgear; 8072 = net-snmp (Linux based: read sysDescr); 25461 = Palo Alto Networks; 29671 = Cisco Meraki; 30065 = Arista.

## 2. Network devices: standard SNMP tables (query these first on any platform)

| Table | OID | What it gives |
|---|---|---|
| sysDescr | `1.3.6.1.2.1.1.1.0` | platform, software version and usually the model |
| sysObjectID | `1.3.6.1.2.1.1.2.0` | vendor (enterprise number) and product |
| sysName | `1.3.6.1.2.1.1.5.0` | configured device name |
| sysLocation | `1.3.6.1.2.1.1.6.0` | configured location (cabinet, room) |
| ifDescr | `1.3.6.1.2.1.2.2.1.2` | interface names by ifIndex |
| ifOperStatus | `1.3.6.1.2.1.2.2.1.8` | link up (1) / down (2) |
| ifPhysAddress | `1.3.6.1.2.1.2.2.1.6` | interface MAC |
| ifHighSpeed | `1.3.6.1.2.1.31.1.1.1.15` | negotiated speed in Mbps |
| ifAlias | `1.3.6.1.2.1.31.1.1.1.18` | port description written by the installer (often the far end) |
| dot3StatsDuplexStatus | `1.3.6.1.2.1.10.7.2.1.19` | duplex: half (2) / full (3) |
| dot1dBasePortIfIndex | `1.3.6.1.2.1.17.1.4.1.2` | bridge port number to ifIndex (needed to read the FDB) |
| dot1dTpFdbPort | `1.3.6.1.2.1.17.4.3.1.2` | MAC to bridge port, VLAN-unaware devices |
| dot1qTpFdbPort | `1.3.6.1.2.1.17.7.1.2.2.1.2` | VLAN + MAC to bridge port |
| dot1qPvid | `1.3.6.1.2.1.17.7.1.4.5.1.1` | access VLAN per port |
| dot1qVlanStaticName | `1.3.6.1.2.1.17.7.1.4.3.1.1` | VLAN names |
| ipNetToMediaPhysAddress | `1.3.6.1.2.1.4.22.1.2` | ARP table: IP to MAC (complete only on the layer-3 gateway) |
| lldpLocPortId | `1.0.8802.1.1.2.1.3.7.1.3` | local port names by LLDP port number |
| lldpRemChassisId | `1.0.8802.1.1.2.1.4.1.1.5` | neighbour chassis id (usually its MAC) |
| lldpRemPortId | `1.0.8802.1.1.2.1.4.1.1.7` | neighbour port |
| lldpRemSysName | `1.0.8802.1.1.2.1.4.1.1.9` | neighbour name |
| lldpRemSysDesc | `1.0.8802.1.1.2.1.4.1.1.10` | neighbour platform |
| lldpRemManAddr | `1.0.8802.1.1.2.1.4.2.1.4` | neighbour management address |
| entPhysicalSerialNum | `1.3.6.1.2.1.47.1.1.1.1.11` | serial numbers (one per stack member) |
| entPhysicalModelName | `1.3.6.1.2.1.47.1.1.1.1.13` | hardware model |
| pethPsePortDetectionStatus | `1.3.6.1.2.1.105.1.1.1.6` | PoE per port: delivering (3) / searching (2) |
| pethMainPseConsumptionPower | `1.3.6.1.2.1.105.1.3.1.1.4` | PoE watts in use; budget is ...1.1.2 |
| upsEstimatedChargeRemaining | `1.3.6.1.2.1.33.1.2.4.0` | UPS battery percent; minutes left is ...2.3.0 |

## 3. How to conclude a link

- An LLDP neighbour read from the device itself is a confirmed link, with both port names.
- A MAC seen on an access port (FDB) plus the ARP table of the gateway places an end device on that port: inferred, not confirmed.
- A port whose FDB holds many MACs is an uplink or carries another switch / AP: do not place those MACs on it as directly attached.
- Access points advertise themselves over LLDP; the switch side tells which port they are on. Wireless clients come from the controller, or from the AP's own FDB.
- No answer is 'unknown', not 'down'.

## 4. Network devices: read-only commands per platform

### H3C Comware 7 (`h3c-comware`)

- Login: ssh / telnet; prompt `<SYSNAME>`; disable paging: `screen-length disable`; read-only role: network-operator
- Evidence: verified on real devices (LA31: version / interface / arp / mac-address / lldp / vlan / stp over read-only SSH; wlan ap all and wlan client on the WX controller)
- Commands: version -> `display version`; inventory -> `display device manuinfo`; interfaces -> `display interface brief`; lldp -> `display lldp neighbor-information list`; lldpDetail -> `display lldp neighbor-information verbose`; mac -> `display mac-address`; arp -> `display arp`; vlan -> `display vlan brief`; stp -> `display stp brief`; poe -> `display poe interface`; stack -> `display irf`; wlanAps -> `display wlan ap all`; wlanClients -> `display wlan client`; wlanClientDetail -> `display wlan client verbose`
- If SNMP is not enabled on the device, ask the operator to enable read-only access like this: snmp-agent; snmp-agent sys-info version v2c v3; a read-only community or a v3 user limited to the probe's address
- Note: fit APs are managed by the controller: ask the AC, not the AP
- Note: MAC addresses print as xxxx-xxxx-xxxx

### Cisco IOS / IOS XE (`cisco-ios`)

- Login: ssh / telnet; prompt `HOSTNAME> or HOSTNAME#`; disable paging: `terminal length 0`; read-only role: privilege level 1 covers most show commands
- Evidence: candidate, unverified
- Commands: version -> `show version`; inventory -> `show inventory`; interfaces -> `show interfaces status`; lldp -> `show lldp neighbors`; lldpDetail -> `show lldp neighbors detail`; cdp -> `show cdp neighbors detail`; mac -> `show mac address-table`; arp -> `show ip arp`; vlan -> `show vlan brief`; stp -> `show spanning-tree summary`; poe -> `show power inline`; stack -> `show switch`
- If SNMP is not enabled on the device, ask the operator to enable read-only access like this: snmp-server community <name> RO <acl>, or a v3 user with a read view
- Note: LLDP is off by default (CDP is on): an empty LLDP table does not mean no neighbours
- Note: MAC addresses print as xxxx.xxxx.xxxx

### Huawei VRP (`huawei-vrp`)

- Login: ssh / telnet; prompt `<SYSNAME>`; disable paging: `screen-length 0 temporary`
- Evidence: candidate, unverified
- Commands: version -> `display version`; inventory -> `display elabel brief`; interfaces -> `display interface brief`; lldp -> `display lldp neighbor brief`; mac -> `display mac-address`; arp -> `display arp`; vlan -> `display vlan`; stp -> `display stp brief`; poe -> `display poe power`; stack -> `display stack`; wlanAps -> `display ap all`; wlanClients -> `display station all`

### HPE Aruba AOS-CX / ArubaOS-Switch (`aruba-aoscx`)

- Login: ssh; disable paging: `no page`
- Evidence: candidate, unverified
- Commands: version -> `show version`; inventory -> `show system`; interfaces -> `show interface brief`; lldp -> `show lldp neighbor-info`; mac -> `show mac-address-table`; arp -> `show arp`; vlan -> `show vlan`; poe -> `show power-over-ethernet brief`
- Note: three enterprise numbers are in use across product lines

### Ruijie RGOS / Reyee (`ruijie-rgos`)

- Login: ssh / telnet; disable paging: `terminal length 0`
- Evidence: candidate, unverified
- Commands: version -> `show version`; interfaces -> `show interfaces status`; lldp -> `show lldp neighbors`; mac -> `show mac-address-table`; arp -> `show arp`; vlan -> `show vlan`; poe -> `show poe interfaces status`; wlanAps -> `show ap-config summary`; wlanClients -> `show ac-config client`

### Juniper Junos (`juniper-junos`)

- Login: ssh; disable paging: `set cli screen-length 0`
- Evidence: candidate, unverified
- Commands: version -> `show version`; inventory -> `show chassis hardware`; interfaces -> `show interfaces terse`; lldp -> `show lldp neighbors`; mac -> `show ethernet-switching table`; arp -> `show arp no-resolve`; vlan -> `show vlans`; poe -> `show poe interface`; stack -> `show virtual-chassis`

### MikroTik RouterOS (`mikrotik-routeros`)

- Login: ssh; disable paging: `append 'without-paging' to print commands`
- Evidence: candidate, unverified
- Commands: version -> `/system resource print`; inventory -> `/system routerboard print`; interfaces -> `/interface print`; lldp -> `/ip neighbor print detail`; mac -> `/interface bridge host print`; arp -> `/ip arp print`; vlan -> `/interface bridge vlan print`; poe -> `/interface ethernet poe print`; wlanClients -> `/interface wireless registration-table print`

### Fortinet FortiOS (`fortinet-fortios`)

- Login: ssh; disable paging: `config system console / set output standard (a configuration change: prefer SNMP)`
- Evidence: candidate, unverified
- Commands: version -> `get system status`; interfaces -> `get system interface physical`; arp -> `get system arp`; routes -> `get router info routing-table all`; lldp -> `diagnose lldprx neighbor summary`
- If SNMP is not enabled on the device, ask the operator to enable read-only access like this: SNMP must be allowed on the interface the probe reaches, and the probe's address listed as a host of the community
- Note: a firewall is discovered and recorded, never logged into to change anything
- Note: LLDP reception is off unless enabled per interface

### Ubiquiti UniFi (`ubiquiti-unifi`)

- Controller interface (candidate, unverified): `https://{controller}/proxy/network/api/s/{site}/stat/device`, gives all adopted devices with model, ports, uplink, clients
- If SNMP is not enabled on the device, ask the operator to enable read-only access like this: enabled per site in the controller; coverage is thin (often no FDB or PoE tables)
- Note: the controller is the authoritative source; ask for a read-only controller account before trying per-device access

### TP-Link Omada / JetStream (`tplink-omada`)

- Login: ssh / telnet; disable paging: `—`
- Evidence: candidate, unverified
- Commands: version -> `show system-info`; interfaces -> `show interface status`; lldp -> `show lldp neighbor-information interface`; mac -> `show mac address-table all`; vlan -> `show vlan brief`; poe -> `show power inline information interface`
- Controller interface (candidate, unverified): `https://{controller}/api/info, then the device and client lists after login`

## 5. Recorders: by protocol family

| Protocol family | Brands | How to identify | Product support |
|---|---|---|---|
| Hikvision ISAPI (`hikvision-isapi`) | hikvision, hilook, annke | port 80/554/8000; GET `/ISAPI/System/deviceInfo` should return XML <DeviceInfo> with <deviceType> NVR / DVR / HybirdNVR (verified on real devices) | supported |
| Dahua HTTP API (CGI) (`dahua-cgi`) | dahua, amcrest, lorex | port 80/554/37777; GET `/cgi-bin/magicBox.cgi?action=getDeviceType` should return text 'type=<model or NVR/DVR>' (vendor documentation / standard) | not supported |
| Uniview LAPI (`uniview-lapi`) | uniview | port 80/554; GET `/LAPI/V1.0/System/DeviceInfo` should return JSON Response.Data.DeviceModel (candidate, unverified) | not supported |
| Hanwha Wisenet SUNAPI (`hanwha-sunapi`) | hanwha | port 80/554; GET `/stw-cgi/system.cgi?msubmenu=deviceinfo&action=view` should return text 'Model=…' and 'DeviceType=NVR' (candidate, unverified) | not supported |
| Reolink HTTP API (api.cgi) (`reolink-api`) | reolink | port 80/443/554/9000; POST `/cgi-bin/api.cgi?cmd=GetDevInfo` should return JSON [ { cmd: GetDevInfo, value: { DevInfo: { type: NVR } } } ] (candidate, unverified) | not supported |
| TP-Link VIGI NVR (RTSP server) (`vigi-rtsp`) | vigi | port 80/443/554/8000 (candidate, unverified) | not supported |
| TVT / Viewtron HTTP API (`tvt-api`) | tvt | port 80/554/6036 (candidate, unverified) | not supported |
| ONVIF Profile G (any conformant recorder) (`onvif-profile-g`) | any | port 80/554; POST `/onvif/device_service` should return GetServices lists the recording, search and replay service namespaces (vendor documentation / standard) | not supported |
| UniFi Protect (`unifi-protect`) | ubiquiti | port 443/7441/7447; GET `https://{host}/proxy/protect/integration/v1/cameras` should return JSON list, with an X-API-KEY header (candidate, unverified) | not supported |

### Hikvision ISAPI (`hikvision-isapi`)

- Authentication: HTTP digest; RTSP digest; **repeated wrong passwords lock the account: stop after the first 401**
- Time: recorder local time (search and playback times are the recorder's wall clock written with a trailing Z; read /ISAPI/System/time and correct for the offset); channel numbers start at 1
- deviceInfo（verified on real devices）：GET `/ISAPI/System/deviceInfo`
- clock（verified on real devices）：GET `/ISAPI/System/time`
- channels（verified on real devices）：GET `/ISAPI/ContentMgmt/InputProxy/channels`
- recordTracks（verified on real devices）：GET `/ISAPI/ContentMgmt/record/tracks`
- search（verified on real devices）：POST `/ISAPI/ContentMgmt/search`
- storage（verified on real devices）：GET `/ISAPI/ContentMgmt/Storage`
- download（verified on real devices）：GET `/ISAPI/ContentMgmt/download`
- Live (verified on real devices): main `/Streaming/Channels/{ch}01`, sub `/Streaming/Channels/{ch}02`
- Playback (verified on real devices): `/Streaming/tracks/{ch}0{stream}/?starttime={start}&endtime={end}`, time written as YYYYMMDDThhmmssZ
- Note: searching the sub-stream track returns playback URIs that still name the main track: rewrite the track number

### Dahua HTTP API (CGI) (`dahua-cgi`)

- Authentication: HTTP digest; RTSP digest
- Time: recorder local time (all API times are the recorder's local time); channel numbers start at 1
- deviceInfo（vendor documentation / standard）：GET `/cgi-bin/magicBox.cgi?action=getSystemInfo`
- clock（vendor documentation / standard）：GET `/cgi-bin/global.cgi?action=getCurrentTime`
- channels（vendor documentation / standard）：GET `/cgi-bin/configManager.cgi?action=getConfig&name=ChannelTitle`
- search（vendor documentation / standard）：GET `/cgi-bin/mediaFileFind.cgi`
- storage（vendor documentation / standard）：GET `/cgi-bin/storageDevice.cgi?action=getDeviceAllInfo`
- download（vendor documentation / standard）：GET `/cgi-bin/loadfile.cgi?action=startLoad&channel={ch}&startTime=YYYY-M-D%20h:m:s&endTime=...&subtype=0`
- Live (vendor documentation / standard): main `/cam/realmonitor?channel={ch}&subtype=0`, sub `/cam/realmonitor?channel={ch}&subtype=1`
- Playback (vendor documentation / standard): `/cam/playback?channel={ch}&starttime={start}&endtime={end}`, time written as YYYY_MM_DD_hh_mm_ss
- Note: the playback URL has no documented stream selector: main stream only
- Note: downloads are DAV, not MP4

### Uniview LAPI (`uniview-lapi`)

- Authentication: HTTP digest; RTSP digest
- Time: UTC (begin / end are Unix time); channel numbers start at 1
- deviceInfo（candidate, unverified）：GET `/LAPI/V1.0/System/DeviceInfo`
- channels（candidate, unverified）：GET `/LAPI/V1.0/Channels/System/ChannelDetailInfos`
- search（candidate, unverified）：GET `/LAPI/V1.0/Channels/{ch}/Media/Video/Streams/0/Records?Begin={start}&End={end}`
- snapshot（vendor documentation / standard）：GET `/LAPI/V1.0/Channels/{ch}/Media/Video/Streams/0/Snapshot`
- Live (vendor documentation / standard): main `/unicast/c{ch}/s0/live`, sub `/unicast/c{ch}/s1/live`
- Playback (vendor documentation / standard): `/c{ch}/b{start}/e{end}/replay/`, time written as unix
- Note: playback is addressable by time without a search, so a recorder can be supported with the RTSP template alone

### Hanwha Wisenet SUNAPI (`hanwha-sunapi`)

- Authentication: HTTP digest; RTSP digest
- Time: UTC; channel numbers start at 0
- deviceInfo（candidate, unverified）：GET `/stw-cgi/system.cgi?msubmenu=deviceinfo&action=view`
- channels（vendor documentation / standard）：GET `/stw-cgi/media.cgi?msubmenu=videoprofilepolicy&action=view`
- search（candidate, unverified）：GET `/stw-cgi/recording.cgi?msubmenu=timeline&action=view&Type=All&ChannelIDList={ch}&FromDate={start}&ToDate={end}`
- Live (vendor documentation / standard): main `/LiveChannel/{ch}/media.smp`, sub `/LiveChannel/{ch}/media.smp/profile=2`
- Playback (candidate, unverified): `/PlaybackChannel/{ch}/media.smp/start={start}&end={end}`, time written as YYYYMMDDhhmmss
- Note: channel numbers start at 0
- Note: which profile number is the low-resolution one differs per channel: read videoprofilepolicy

### Reolink HTTP API (api.cgi) (`reolink-api`)

- Authentication: HTTP user and password in the query string, or a token from cmd=Login; RTSP digest or basic
- Time: recorder local time; channel numbers start at 0
- deviceInfo（candidate, unverified）：POST `/cgi-bin/api.cgi?cmd=GetDevInfo`
- channels（candidate, unverified）：POST `/cgi-bin/api.cgi?cmd=GetChannelstatus`
- search（vendor documentation / standard）：POST `/cgi-bin/api.cgi?cmd=Search`
- storage（candidate, unverified）：POST `/cgi-bin/api.cgi?cmd=GetHddInfo`
- download（candidate, unverified）：GET `/cgi-bin/api.cgi?cmd=Download&source=<file name>&output=<file name>`
- Live (vendor documentation / standard): main `/Preview_{ch2}_main`, sub `/Preview_{ch2}_sub`
- Note: no RTSP playback: recordings are files found by Search, then played over RTMP / FLV or downloaded

### TP-Link VIGI NVR (RTSP server) (`vigi-rtsp`)

- Authentication: HTTP —; RTSP digest (MD5 by default; SHA-256 optional)
- Time: UTC (starttime / endtime are UTC+0); channel numbers start at 1
- Live (vendor documentation / standard): main `/live/{ch}/1/avm`, sub `/live/{ch}/2/avm`
- Playback (vendor documentation / standard): `/replay/{ch}/{stream}/avm?starttime={start}&endtime={end}`, time written as YYYYMMDDthhmmssz
- Note: no documented search interface: playback by time only
- Note: SRTP must be off for third-party clients

### TVT / Viewtron HTTP API (`tvt-api`)

- Authentication: HTTP basic; RTSP basic or digest
- Time: recorder local time; channel numbers start at 1
- search（vendor documentation / standard）：POST `/SearchByTime/{ch}`
- snapshot（vendor documentation / standard）：GET `/GetSnapshot/{ch}`
- Live (candidate, unverified): main `/chID={ch}&streamType=main&linkType=tcp`, sub `/chID={ch}&streamType=sub&linkType=tcp`
- Playback (vendor documentation / standard): `/chID={ch}&date={date}&time={time}&timelen={seconds}&streamType={stream}&action=playback`
- Note: the search response format is not in the public page: capture one from a device before writing a parser

### ONVIF Profile G (any conformant recorder) (`onvif-profile-g`)

- Authentication: HTTP WS-UsernameToken (PasswordDigest) or HTTP digest; RTSP digest
- Time: UTC; channel numbers start at 1
- deviceInfo（vendor documentation / standard）：SOAP `GetDeviceInformation`
- channels（vendor documentation / standard）：SOAP `search service: FindRecordings + GetRecordingSearchResults (one recording per source)`
- search（vendor documentation / standard）：SOAP `RecordingInformation.EarliestRecording / LatestRecording; FindEvents for recording start / stop inside a range`
- playbackUri（vendor documentation / standard）：SOAP `replay service: GetReplayUri(RecordingToken)`
- Playback (vendor documentation / standard): `(URI returned by GetReplayUri)`
- Note: one driver covers every Profile G conformant recorder, at the cost of per-vendor quirks

### UniFi Protect (`unifi-protect`)

- Authentication: HTTP API key (X-API-KEY) or a login session cookie; RTSP token inside the generated stream URL
- Time: UTC; channel numbers start at 0
- channels（candidate, unverified）：GET `/proxy/protect/integration/v1/cameras`
- download（candidate, unverified）：GET `/proxy/protect/api/video/export?camera={id}&start={startMs}&end={endMs}`
- Note: HTTPS only
- Note: no RTSP playback: recorded video is exported as MP4 by time range
- Note: not simulated

## 6. Cameras: brands and stream path conventions

The library has 143 brands. Common ONVIF ports: 80, 8000, 8080, 2020. Identify the brand from the ONVIF manufacturer name, the HTTP auth realm and the model wording. Below is the preferred main / sub stream path pair for each brand (`{ch}` is the channel number):

| Brand | Aliases | RTSP port | Main stream | Sub stream | Evidence |
|---|---|---|---|---|---|
| 360 Vision Technology | 360-vision, 360vision, 360 vision | 554 | `/h264main` | `/h264sub` | vendor documentation / standard |
| 3S Vision | 3svision, 3s vision | 554 | `/cam{ch}/h264-1` | `/cam{ch}/h264-2` | candidate, unverified |
| ABUS | abus | 554 | `/h264` | `/mpeg4` | candidate, unverified |
| ACTi | acti | 7070 | `/stream1` | `/stream2` | vendor documentation / standard |
| Advidia | advidia | 554 | `/media/video1` | `/media/video2` | candidate, unverified |
| Akuvox | akuvox | 554 | `/live/ch00_0` | `/live/ch00_1` | vendor documentation / standard |
| Alibi | alibi | 554 | `/Streaming/Channels/101` | `/Streaming/Channels/102` | candidate, unverified |
| Amcrest | amcrest | 554 | `/cam/realmonitor?channel={ch}&subtype=0` | `/cam/realmonitor?channel={ch}&subtype=1` | vendor documentation / standard |
| American Dynamics | american-dynamics, americandynamics, american dynamics | 554 | `/primarystream` | `/secondarystream` | vendor documentation / standard |
| ANNKE | annke | 554 | `/H264/ch{ch}/main/av_stream` | `/H264/ch{ch}/sub/av_stream` | vendor documentation / standard |
| Anpviz | anpviz | 554 | `/Streaming/Channels/101` | `/Streaming/Channels/102` | candidate, unverified |
| Arecont Vision | arecont, arecont vision | 554 | `/h264.sdp?res=full&doublescan=0&ssn=1` | `/h264.sdp?res=half&doublescan=0&ssn=2` | vendor documentation / standard |
| AvertX | avertx | 554 | `/h264` | `/h264_2` | candidate, unverified |
| Avigilon | avigilon | 554 | `/defaultPrimary?streamType=u` | `/defaultSecondary?streamType=u` | candidate, unverified |
| AVYCON | avycon | 554 | `/rtsp/streaming?channel=01&subtype=0` | `/rtsp/streaming?channel=01&subtype=1` | vendor documentation / standard |
| Axis Communications | axis, axis communications | 554 | `/axis-media/media.amp` | `/axis-media/media.amp?videocodec=h264&resolution=640x480` | vendor documentation / standard |
| BEWARD | beward | 554 | `/av0_0` | `/av0_1` | vendor documentation / standard |
| Boavision | boavision | 554 | `/11` | `/12` | candidate, unverified |
| Bolin Technology | bolin, bolin technology | 554 | `/media/video1` | `/media/video2` | vendor documentation / standard |
| Bosch Security Systems | bosch, bosch security systems | 554 | `/?inst=1` | `/?inst=2` | vendor documentation / standard |
| Brickcom | brickcom | 554 | `/channel1` | `/channel2` | vendor documentation / standard |
| Camius | camius | 80 | `/rtsp/streaming?channel={ch}&subtype=0` | `/rtsp/streaming?channel={ch}&subtype=1` | vendor documentation / standard |
| Canon | canon | 554 | `/rtpstream/config1=r` | `/rtpstream/config2=r` | vendor documentation / standard |
| Cisco | cisco | 554 | `/live.sdp` | `/live2.sdp` | candidate, unverified |
| ClareVision | clarevision | 554 | `/0` | `/1` | vendor documentation / standard |
| Comelit | comelit | 554 | `/profile1` | `/profile2` | vendor documentation / standard |
| Costar | costar | 554 | `/trackID=1` | `/trackID=2` | vendor documentation / standard |
| CP Plus | cp-plus, cpplus, cp plus | 554 | `/cam/realmonitor?channel={ch}&subtype=0` | `/cam/realmonitor?channel={ch}&subtype=1` | vendor documentation / standard |
| Dahua | dahua, 大华 | 554 | `/cam/realmonitor?channel={ch}&subtype=0` | `/cam/realmonitor?channel={ch}&subtype=1` | vendor documentation / standard |
| Dallmeier | dallmeier | 554 | `/encoder1` | `/encoder2` | vendor documentation / standard |
| DBPOWER | db-power, dbpower, db power | 554 | `/live/ch0` | `/live/ch1` | candidate, unverified |
| Dericam | dericam | 554 | `/11` | `/12` | candidate, unverified |
| Digital Watchdog | digital-watchdog, digitalwatchdog, digital watchdog | 554 | `/profile1` | `/profile2` | vendor documentation / standard |
| eneo | eneo | 554 | `/1/stream1` | `/1/stream2` | vendor documentation / standard |
| Ernitec | ernitec | 554 | `/snl/live/1/1` | `/snl/live/1/2` | vendor documentation / standard |
| ESCAM | escam | 554 | `/live/0/main` | `/live/0/sub` | vendor documentation / standard |
| EverFocus | everfocus | 554 | `/ch01/0` | `/ch01/1` | candidate, unverified |
| FLIR Systems | flir, flir systems | 554 | `/stream1` | `/stream2` | vendor documentation / standard |
| Foscam | foscam | 88 | `/videoMain` | `/videoSub` | vendor documentation / standard |
| Genie | genie | 554 | `/profile1` | `/profile2` | vendor documentation / standard |
| Grandstream | grandstream | 554 | `/0` | `/4` | candidate, unverified |
| Hanwha Vision | hanwha, hanwha vision | 554 | `/profile2/media.smp` | `/profile3/media.smp` | vendor documentation / standard |
| Hikvision | hikvision, 海康 | 554 | `/Streaming/Channels/{ch}01` | `/Streaming/Channels/{ch}02` | vendor documentation / standard |
| HiLook | hilook | 554 | `/Streaming/Channels/{ch}01` | `/Streaming/Channels/{ch}02` | vendor documentation / standard |
| HiWatch | hiwatch | 554 | `/Streaming/Channels/{ch}01` | `/Streaming/Channels/{ch}02` | vendor documentation / standard |
| HOLOWITS | holowits | 554 | `/LiveMedia/ch1/Media1` | `/LiveMedia/ch1/Media2` | vendor documentation / standard |
| Honeywell | honeywell | 554 | `/live1s1.sdp` | `/live1s2.sdp` | vendor documentation / standard |
| HOSAFE | hosafe | 554 | `/11` | `/12` | vendor documentation / standard |
| i-PRO | i-pro, ipro, i pro | 554 | `/Src/MediaInput/stream_1` | `/Src/MediaInput/stream_2` | vendor documentation / standard |
| IDIS | idis | 554 | `/trackID=1` | `/trackID=2` | vendor documentation / standard |
| ieGeek | iegeek | 554 | `/11` | `/12` | vendor documentation / standard |
| Illustra | illustra | 554 | `/videoStreamId=1` | `/videoStreamId=2` | vendor documentation / standard |
| INSTAR | instar | 554 | `/livestream/11` | `/livestream/12` | vendor documentation / standard |
| Intelbras | intelbras | 554 | `/cam/realmonitor?channel={ch}&subtype=0` | `/cam/realmonitor?channel={ch}&subtype=1` | candidate, unverified |
| IQeye | iq-eye, iqeye, iq eye | 554 | `/now.mp4&res=high` | `/now.mp4&res=low` | candidate, unverified |
| JideTech | jidetech | 554 | `/stream0` | `/stream1` | vendor documentation / standard |
| JVC | jvc | 554 | `/PSIA/Streaming/channels/0` | `/PSIA/Streaming/channels/1` | candidate, unverified |
| Kedacom | kedacom | 554 | `/id=0` | `/id=1` | vendor documentation / standard |
| LevelOne | levelone | 554 | `/live1.sdp` | `/live2.sdp` | vendor documentation / standard |
| LILIN | lilin | 554 | `/stream0` | `/stream1` | vendor documentation / standard |
| Longse | longse | 554 | `/0` | `/1` | vendor documentation / standard |
| Lorex | lorex | 554 | `/cam/realmonitor?channel={ch}&subtype=0` | `/cam/realmonitor?channel={ch}&subtype=1` | candidate, unverified |
| Loryta | loryta | 554 | `/cam/realmonitor?channel={ch}&subtype=0` | `/cam/realmonitor?channel={ch}&subtype=1` | candidate, unverified |
| LTS | lts | 554 | `/Streaming/Channels/101` | `/Streaming/Channels/102` | vendor documentation / standard |
| Luma | luma | 554 | `/Streaming/channels/1` | `/Streaming/channels/2` | vendor documentation / standard |
| Luminys | luminys | 554 | `/video/livemedia?Ch={ch}&Streamtype=0` | `/video/livemedia?Ch={ch}&Streamtype=1` | vendor documentation / standard |
| Lupus Electronics | lupus, lupus electronics | 554 | `/cam/realmonitor?channel=1&subtype=0` | `/cam/realmonitor?channel=1&subtype=1` | vendor documentation / standard |
| Merit LILIN | merit-lilin, meritlilin, merit lilin | 554 | `/stream0` | `/stream1` | vendor documentation / standard |
| Messoa | messoa | 554 | `/stream1` | `/stream2` | vendor documentation / standard |
| Milesight | milesight | 554 | `/main` | `/sub` | vendor documentation / standard |
| Mobotix | mobotix | 554 | `/stream/profile0` | `/stream/profile1` | vendor documentation / standard |
| Motorola | motorola | 554 | `/defaultPrimary?streamType=u` | `/defaultSecondary?streamType=u` | vendor documentation / standard |
| Night Owl | night-owl, nightowl, night owl | 554 | `/ch{ch2}/0` | `/ch{ch2}/1` | vendor documentation / standard |
| Nuvico | nuvico | 554 | `/profile1` | `/profile2` | vendor documentation / standard |
| Oncam | oncam | 554 | `/h264/video.sdp?camera=13` | `/h264/video.sdp?camera=12` | vendor documentation / standard |
| Panasonic i-PRO | panasonic, panasonic i-pro | 554 | `/Src/MediaInput/stream_1` | `/Src/MediaInput/stream_2` | candidate, unverified |
| Pelco | pelco | 554 | `/stream1` | `/stream2` | vendor documentation / standard |
| PLANET Technology | planet, planet technology | 554 | `/stander/livestream/0/0` | `/stander/livestream/0/1` | vendor documentation / standard |
| Q-See | q-see, qsee, q see | 554 | `/cam/realmonitor?channel={ch}&subtype=0` | `/cam/realmonitor?channel={ch}&subtype=1` | candidate, unverified |
| Reolink | reolink | 554 | `/Preview_{ch2}_main` | `/Preview_{ch2}_sub` | vendor documentation / standard |
| Revotech | revotech | 554 | `/mpeg4` | `/mpeg4cif` | candidate, unverified |
| RVi | rvi | 554 | `/RVi/1/1` | `/RVi/1/2` | candidate, unverified |
| Samsung | samsung | 554 | `/profile2/media.smp` | `/profile3/media.smp` | vendor documentation / standard |
| SANNCE | sannce | 554 | `/{ch}/1` | `/{ch}/2` | vendor documentation / standard |
| Siqura | siqura | 554 | `/VideoInput/1/h264/1` | `/VideoInput/1/mpeg4/1` | vendor documentation / standard |
| Sony (IPELA) | sony | 554 | `/video1` | `/video2` | candidate, unverified |
| Speco Technologies | speco, speco technologies | 9008 | `/profile1` | `/profile2` | vendor documentation / standard |
| Sricam | sricam | 554 | `/1/h264major` | `/1/h264minor` | vendor documentation / standard |
| SriHome | srihome | 554 | `/1/h264major` | `/1/h264minor` | vendor documentation / standard |
| Sunba | sunba | 554 | `/media/video1` | `/media/video2` | candidate, unverified |
| Sunell | sunell | 554 | `/snl/live/1/1` | `/snl/live/1/2` | vendor documentation / standard |
| Surveon | surveon | 554 | `/stream1` | `/stream2` | candidate, unverified |
| SV3C | sv3c | 554 | `/stream0` | `/stream1` | vendor documentation / standard |
| Swann | swann | 554 | `/ch{ch}/0` | `/ch{ch}/1` | candidate, unverified |
| Synology | synology | 554 | `/1` | `/2` | vendor documentation / standard |
| TP-Link Tapo | tapo, tp-link tapo, tp-link | 554 | `/stream1` | `/stream2` | verified on real devices |
| Tenda | tenda | 8554 | `/profile0` | `/profile1` | vendor documentation / standard |
| TENVIS | tenvis | 554 | `/11` | `/12` | candidate, unverified |
| Toshiba | toshiba | 554 | `/live.sdp` | `/live2.sdp` | vendor documentation / standard |
| TP-Link | tp-link, tplink, tp link | 554 | `/stream1` | `/stream2` | vendor documentation / standard |
| Trassir | trassir | 554 | `/live/main` | `/live/sub` | vendor documentation / standard |
| TRENDnet | trendnet | 554 | `/Src/MediaInput/stream_1` | `/Src/MediaInput/stream_2` | candidate, unverified |
| TruVision | truvision | 554 | `/Streaming/Channels/{ch}01` | `/Streaming/Channels/{ch}02` | candidate, unverified |
| TVT Digital | tvt, tvt digital | 554 | `/profile1` | `/profile2` | candidate, unverified |
| Uniarch | uniarch | 554 | `/media/video1` | `/media/video2` | vendor documentation / standard |
| Uniview | uniview, unv, uniarch | 554 | `/media/video1` | `/media/video2` | vendor documentation / standard |
| Urmet | urmet | 554 | `/ch01/0` | `/ch01/1` | vendor documentation / standard |
| V380 | v380 | 554 | `/live/ch00_1` | `/live/ch00_0` | vendor documentation / standard |
| Verkada | verkada | 8554 | `/high` | `/standard` | vendor documentation / standard |
| Vicon | vicon | 554 | `/stream1` | `/stream2` | vendor documentation / standard |
| VIGI | vigi | 554 | `/stream1` | `/stream2` | vendor documentation / standard |
| Vikylin | vikylin | 554 | `/stream0` | `/stream1` | vendor documentation / standard |
| Vitek | vitek | 554 | `/profile1` | `/profile2` | vendor documentation / standard |
| Vivotek | vivotek | 554 | `/live1s1.sdp` | `/live1s2.sdp` | vendor documentation / standard |
| VStarcam | vstarcam | 10554 | `/tcp/av0_0` | `/udp/av0_1` | candidate, unverified |
| Wansview | wansview | 554 | `/live/ch0` | `/live/ch1` | candidate, unverified |
| Wisenet | wisenet | 554 | `/profile2/media.smp` | `/profile3/media.smp` | vendor documentation / standard |
| Xvision | xvision | 554 | `/ch00/0` | `/ch00/1` | candidate, unverified |
| Zavio | zavio | 554 | `/video.pro1` | `/video.pro2` | vendor documentation / standard |
| ZOSI | zosi | 554 | `/video1` | `/video2` | vendor documentation / standard |
| 通用候选（旧代码里的写法，厂家未证实） |  | 554 | `/h264/ch1/main/av_stream` | `/h264/ch1/sub/av_stream` | candidate, unverified |

When probing streams, first send a path that does not exist: the path is only proven correct if the device returns 404 for it and 401 for the real path; a device that returns 401 for everything cannot be told apart.
