export type Activity = {id: string; text: string; at: number};
export type ProjectAssetRef = {
  assetId: string;
  dataFormat: string;
  assetType: "ImageVector" | "ImageBitmap" | "Sound";
  byteLength: number;
};

export const MAX_PROJECT_ASSET_BYTES = 1_750_000;
export const MAX_PROJECT_ASSETS = 100;
export const MAX_PROJECT_ASSET_TOTAL_BYTES = 50 * 1024 * 1024;
export const MAX_PROJECT_STATE_BYTES = 1_750_000;

export type ProjectState = {
  blocksXml: string;
  projectJson?: string;
  eventSeq: number;
  structuralVersion: number;
  assets: ProjectAssetRef[];
  selectedSprite: string;
  stageBackdrop: string;
  activity: Activity[];
};

const colour = (primary: string, secondary: string, tertiary: string) => ({
  colourPrimary: primary,
  colourSecondary: secondary,
  colourTertiary: tertiary,
  colourQuaternary: tertiary,
});

// Scratch Blocks names these keys with British spelling and reads every one
// while constructing its renderer. This mirrors Scratch GUI's default mode.
export const scratchBlockColors = {
  motion: colour("#4C97FF", "#4280D7", "#3373CC"),
  looks: colour("#9966FF", "#855CD6", "#774DCB"),
  sounds: colour("#CF63CF", "#C94FC9", "#BD42BD"),
  control: colour("#FFAB19", "#EC9C13", "#CF8B17"),
  event: colour("#FFBF00", "#E6AC00", "#CC9900"),
  sensing: colour("#5CB1D6", "#47A8D1", "#2E8EB8"),
  pen: colour("#0FBD8C", "#0DA57A", "#0B8E69"),
  operators: colour("#59C059", "#46B946", "#389438"),
  data: colour("#FF8C1A", "#FF8000", "#DB6E00"),
  data_lists: colour("#FF661A", "#FF5500", "#E64D00"),
  more: colour("#FF6680", "#FF4D6A", "#FF3355"),
  text: "#FFFFFF", workspace: "#F9F9F9", toolboxHover: "#4C97FF", toolboxSelected: "#E9EEF2",
  toolboxText: "#575E75", toolbox: "#FFFFFF", flyout: "#F9F9F9", scrollbar: "#CECDCE",
  scrollbarHover: "#CECDCE", textField: "#FFFFFF", textFieldText: "#575E75", insertionMarker: "#000000",
  insertionMarkerOpacity: 0.2, dragShadowOpacity: 0.6, stackGlow: "#FFF200", stackGlowSize: 4,
  stackGlowOpacity: 1, replacementGlow: "#FFFFFF", replacementGlowSize: 2, replacementGlowOpacity: 1,
  colourPickerStroke: "#FFFFFF", fieldShadow: "rgba(255, 255, 255, 0.3)", dropDownShadow: "rgba(0, 0, 0, .3)",
  numPadBackground: "#547AB2", numPadBorder: "#435F91", numPadActiveBackground: "#435F91", numPadText: "white",
  valueReportBackground: "#FFFFFF", valueReportBorder: "#AAAAAA", menuHover: "rgba(0, 0, 0, 0.2)",
};

export const scratchThemeBlockStyles = {
  motion: scratchBlockColors.motion, looks: scratchBlockColors.looks, sounds: scratchBlockColors.sounds,
  control: scratchBlockColors.control, event: scratchBlockColors.event, sensing: scratchBlockColors.sensing,
  pen: scratchBlockColors.pen, operators: scratchBlockColors.operators, data: scratchBlockColors.data,
  data_lists: scratchBlockColors.data_lists, more: scratchBlockColors.more,
  textField: colour("#FFFFFF", "#FFFFFF", "#FFFFFF"),
};

export const scratchThemeComponents = {
  workspaceBackgroundColour: scratchBlockColors.workspace,
  toolboxBackgroundColour: scratchBlockColors.toolbox,
  toolboxForegroundColour: scratchBlockColors.toolboxText,
  flyoutBackgroundColour: scratchBlockColors.flyout,
  flyoutForegroundColour: scratchBlockColors.toolboxText,
  scrollbarColour: scratchBlockColors.scrollbar,
  insertionMarkerColour: scratchBlockColors.insertionMarker,
  insertionMarkerOpacity: scratchBlockColors.insertionMarkerOpacity,
  selectedGlowColour: scratchBlockColors.stackGlow,
  replacementGlowColour: scratchBlockColors.replacementGlow,
};

export const starterXml = `<xml xmlns="https://developers.google.com/blockly/xml">
  <block type="event_whenflagclicked" id="lumo_flag" x="72" y="52">
    <next><block type="motion_movesteps" id="lumo_move"><value name="STEPS"><shadow type="math_number" id="lumo_steps"><field name="NUM">24</field></shadow></value>
      <next><block type="looks_sayforsecs" id="lumo_say"><value name="MESSAGE"><shadow type="text" id="lumo_message"><field name="TEXT">¡Hola, equipo!</field></shadow></value><value name="SECS"><shadow type="math_number" id="lumo_secs"><field name="NUM">2</field></shadow></value></block></next>
    </block></next>
  </block>
</xml>`;

const value = (name: string, type: string, field = "", content = "") =>
  `<value name="${name}"><shadow type="${type}">${field ? `<field name="${field}">${content}</field>` : ""}</shadow></value>`;
const number = (name: string, content: string, type = "math_number") => value(name, type, "NUM", content);
const text = (name: string, content: string) => value(name, "text", "TEXT", content);
const menu = (name: string, type: string, field = "", content = "") => value(name, type, field, content);

const defaults: Record<string, string> = {
  motion_movesteps: number("STEPS", "10"), motion_turnright: number("DEGREES", "15"), motion_turnleft: number("DEGREES", "15"),
  motion_goto: menu("TO", "motion_goto_menu"), motion_gotoxy: number("X", "0") + number("Y", "0"),
  motion_glideto: number("SECS", "1") + menu("TO", "motion_glideto_menu"), motion_glidesecstoxy: number("SECS", "1") + number("X", "0") + number("Y", "0"),
  motion_pointindirection: number("DIRECTION", "90", "math_angle"), motion_pointtowards: menu("TOWARDS", "motion_pointtowards_menu"),
  motion_changexby: number("DX", "10"), motion_setx: number("X", "0"), motion_changeyby: number("DY", "10"), motion_sety: number("Y", "0"),
  looks_sayforsecs: text("MESSAGE", "¡Hola!") + number("SECS", "2"), looks_say: text("MESSAGE", "¡Hola!"),
  looks_thinkforsecs: text("MESSAGE", "Mmm...") + number("SECS", "2"), looks_think: text("MESSAGE", "Mmm..."),
  looks_switchcostumeto: menu("COSTUME", "looks_costume"), looks_switchbackdropto: menu("BACKDROP", "looks_backdrops"),
  looks_switchbackdroptoandwait: menu("BACKDROP", "looks_backdrops"), looks_changesizeby: number("CHANGE", "10"), looks_setsizeto: number("SIZE", "100"),
  looks_changeeffectby: number("CHANGE", "25"), looks_seteffectto: number("VALUE", "0"), looks_goforwardbackwardlayers: number("NUM", "1", "math_integer"),
  sound_playuntildone: menu("SOUND_MENU", "sound_sounds_menu"), sound_play: menu("SOUND_MENU", "sound_sounds_menu"),
  sound_changeeffectby: number("VALUE", "10"), sound_seteffectto: number("VALUE", "100"), sound_changevolumeby: number("VOLUME", "-10"), sound_setvolumeto: number("VOLUME", "100"),
  event_whengreaterthan: number("VALUE", "10"), event_broadcast: menu("BROADCAST_INPUT", "event_broadcast_menu"), event_broadcastandwait: menu("BROADCAST_INPUT", "event_broadcast_menu"),
  control_wait: number("DURATION", "1", "math_positive_number"), control_repeat: number("TIMES", "10", "math_whole_number"), control_create_clone_of: menu("CLONE_OPTION", "control_create_clone_of_menu"),
  sensing_touchingobject: menu("TOUCHINGOBJECTMENU", "sensing_touchingobjectmenu"), sensing_touchingcolor: menu("COLOR", "colour_picker"),
  sensing_coloristouchingcolor: menu("COLOR", "colour_picker") + menu("COLOR2", "colour_picker"), sensing_distanceto: menu("DISTANCETOMENU", "sensing_distancetomenu"),
  sensing_askandwait: text("QUESTION", "¿Cómo te llamas?"), sensing_keypressed: menu("KEY_OPTION", "sensing_keyoptions"), sensing_of: menu("OBJECT", "sensing_of_object_menu"),
  operator_add: number("NUM1", "") + number("NUM2", ""), operator_subtract: number("NUM1", "") + number("NUM2", ""),
  operator_multiply: number("NUM1", "") + number("NUM2", ""), operator_divide: number("NUM1", "") + number("NUM2", ""),
  operator_random: number("FROM", "1") + number("TO", "10"), operator_gt: text("OPERAND1", "") + text("OPERAND2", "50"),
  operator_lt: text("OPERAND1", "") + text("OPERAND2", "50"), operator_equals: text("OPERAND1", "") + text("OPERAND2", "50"),
  operator_join: text("STRING1", "manzana ") + text("STRING2", "banana"), operator_letter_of: number("LETTER", "1", "math_whole_number") + text("STRING", "manzana"),
  operator_length: text("STRING", "manzana"), operator_contains: text("STRING1", "manzana") + text("STRING2", "a"),
  operator_mod: number("NUM1", "") + number("NUM2", ""), operator_round: number("NUM", ""), operator_mathop: number("NUM", ""),
};

const block = (type: string) => `<block type="${type}">${defaults[type] ?? ""}</block>`;
const category = (name: string, id: string, colour: string, blocks: string[]) =>
  `<category name="${name}" toolboxitemid="${id}" colour="${colour}">${blocks.map(block).join("")}</category>`;

export function makeCoreToolbox(isStage = false, extensionCategories: Array<{xml: string}> = []) {
  const motion = isStage ? [] : ["motion_movesteps", "motion_turnright", "motion_turnleft", "motion_goto", "motion_gotoxy", "motion_glideto", "motion_glidesecstoxy", "motion_pointindirection", "motion_pointtowards", "motion_changexby", "motion_setx", "motion_changeyby", "motion_sety", "motion_ifonedgebounce", "motion_setrotationstyle", "motion_xposition", "motion_yposition", "motion_direction"];
  const looks = isStage
    ? ["looks_switchbackdropto", "looks_switchbackdroptoandwait", "looks_nextbackdrop", "looks_changeeffectby", "looks_seteffectto", "looks_cleargraphiceffects", "looks_backdropnumbername"]
    : ["looks_sayforsecs", "looks_say", "looks_thinkforsecs", "looks_think", "looks_switchcostumeto", "looks_nextcostume", "looks_switchbackdropto", "looks_nextbackdrop", "looks_changesizeby", "looks_setsizeto", "looks_changeeffectby", "looks_seteffectto", "looks_cleargraphiceffects", "looks_show", "looks_hide", "looks_gotofrontback", "looks_goforwardbackwardlayers", "looks_costumenumbername", "looks_backdropnumbername", "looks_size"];
  const events = ["event_whenflagclicked", "event_whenkeypressed", isStage ? "event_whenstageclicked" : "event_whenthisspriteclicked", "event_whenbackdropswitchesto", "event_whengreaterthan", "event_whenbroadcastreceived", "event_broadcast", "event_broadcastandwait"];
  const control = ["control_wait", "control_repeat", "control_forever", "control_if", "control_if_else", "control_wait_until", "control_repeat_until", "control_stop", ...(isStage ? [] : ["control_start_as_clone"]), "control_create_clone_of", ...(isStage ? [] : ["control_delete_this_clone"])];
  const sensing = [...(isStage ? [] : ["sensing_touchingobject", "sensing_touchingcolor", "sensing_coloristouchingcolor", "sensing_distanceto"]), "sensing_askandwait", "sensing_answer", "sensing_keypressed", "sensing_mousedown", "sensing_mousex", "sensing_mousey", ...(isStage ? [] : ["sensing_setdragmode"]), "sensing_loudness", "sensing_timer", "sensing_resettimer", "sensing_of", "sensing_current", "sensing_dayssince2000", "sensing_username"];
  return `<xml style="display:none">
${category("Movimiento", "motion", "#4C97FF", motion)}
${category("Apariencia", "looks", "#9966FF", looks)}
${category("Sonido", "sound", "#CF63CF", ["sound_playuntildone", "sound_play", "sound_stopallsounds", "sound_changeeffectby", "sound_seteffectto", "sound_cleareffects", "sound_changevolumeby", "sound_setvolumeto", "sound_volume"])}
${category("Eventos", "event", "#FFBF00", events)}
${category("Control", "control", "#FFAB19", control)}
${category("Sensores", "sensing", "#5CB1D6", sensing)}
${category("Operadores", "operators", "#59C059", ["operator_add", "operator_subtract", "operator_multiply", "operator_divide", "operator_random", "operator_gt", "operator_lt", "operator_equals", "operator_and", "operator_or", "operator_not", "operator_join", "operator_letter_of", "operator_length", "operator_contains", "operator_mod", "operator_round", "operator_mathop"])}
<category name="Variables" toolboxitemid="variables" colour="#FF8C1A" custom="VARIABLE"/>
<category name="Mis bloques" toolboxitemid="myBlocks" colour="#FF6680" custom="PROCEDURE"/>
${extensionCategories.map(item => item.xml).join("\n")}
</xml>`;
}

export const coreToolbox = makeCoreToolbox(false);

export const stageSvg = `<svg xmlns="http://www.w3.org/2000/svg" width="480" height="360" viewBox="0 0 480 360"><defs><linearGradient id="sky" x2="0" y2="1"><stop stop-color="#17194d"/><stop offset=".58" stop-color="#514989"/><stop offset="1" stop-color="#9b78ad"/></linearGradient></defs><rect width="480" height="360" fill="url(#sky)"/><circle cx="385" cy="72" r="43" fill="#fff4bd"/><circle cx="369" cy="61" r="42" fill="#29285f"/><g fill="#fff" opacity=".8"><circle cx="52" cy="63" r="2"/><circle cx="132" cy="39" r="3"/><circle cx="226" cy="83" r="2"/><circle cx="304" cy="42" r="2"/><circle cx="432" cy="133" r="3"/></g><path d="M0 265Q105 180 240 275T480 248V360H0Z" fill="#315a68"/><path d="M0 305Q155 230 310 310T480 274V360H0Z" fill="#234b5a"/></svg>`;

export const lumiSvg = `<svg xmlns="http://www.w3.org/2000/svg" width="160" height="170" viewBox="0 0 160 170"><g stroke="#6f5861" stroke-width="5" stroke-linecap="round" stroke-linejoin="round"><path fill="#f8e4a0" d="M43 48 29 9Q63 17 72 44M117 48l14-39q-34 8-43 35"/><path fill="#f8e4a0" d="M80 37c42 0 67 29 67 70 0 38-27 57-67 57s-67-19-67-57c0-41 25-70 67-70Z"/><path fill="none" d="M55 92h1m48 0h1M62 119q18 15 36 0"/><path fill="#f0c878" d="M139 126q25 1 12 24-7 11-19 4"/></g><circle cx="54" cy="91" r="4" fill="#6f5861"/><circle cx="106" cy="91" r="4" fill="#6f5861"/></svg>`;

export function buildStarterProject(stageAssetId: string, spriteAssetId: string) {
  const costume = (name: string, assetId: string, cx: number, cy: number) => ({
    name, bitmapResolution: 1, dataFormat: "svg", assetId, md5ext: `${assetId}.svg`, rotationCenterX: cx, rotationCenterY: cy,
  });
  return {
    targets: [
      // Scratch 3's project schema requires the stage target name to remain
      // exactly "Stage". The editor still presents it as "Escenario" in the UI.
      {isStage: true, name: "Stage", variables: {}, lists: {}, broadcasts: {}, blocks: {}, comments: {}, currentCostume: 0, costumes: [costume("Bosque lunar", stageAssetId, 240, 180)], sounds: [], volume: 100, layerOrder: 0, tempo: 60, videoTransparency: 50, videoState: "on", textToSpeechLanguage: null},
      {isStage: false, name: "Lumi", variables: {}, lists: {}, broadcasts: {}, blocks: {
        lumo_flag: {opcode: "event_whenflagclicked", next: "lumo_move", parent: null, inputs: {}, fields: {}, shadow: false, topLevel: true, x: 72, y: 52},
        lumo_move: {opcode: "motion_movesteps", next: "lumo_say", parent: "lumo_flag", inputs: {STEPS: [1, [4, "24"]]}, fields: {}, shadow: false, topLevel: false},
        lumo_say: {opcode: "looks_sayforsecs", next: null, parent: "lumo_move", inputs: {MESSAGE: [1, [10, "¡Hola, equipo!"]], SECS: [1, [4, "2"]]}, fields: {}, shadow: false, topLevel: false},
      }, comments: {}, currentCostume: 0, costumes: [costume("Lumi", spriteAssetId, 80, 85)], sounds: [], volume: 100, layerOrder: 1, visible: true, x: 0, y: -30, size: 70, direction: 90, draggable: false, rotationStyle: "all around"},
    ],
    monitors: [], extensions: [], meta: {semver: "3.0.0", vm: "14.1.0", agent: "Lumo Studio"},
  };
}
