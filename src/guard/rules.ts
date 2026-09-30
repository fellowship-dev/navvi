/**
 * U13 / R17: the patterns that mark page text as an instruction to the model
 * reading it, rather than content for the person reading the page.
 *
 * The hard half of this problem is not catching "ignore all previous
 * instructions". It is staying quiet on commercial pages, which are full of
 * imperatives aimed at people: "Add to cart", "Please select a size", "Do not
 * exceed the stated dose", "Ignore the negative reviews". So every rule here
 * names something only a model has -- its instructions, its task, its
 * response, its role, its chat markup -- or a wrapper known from published
 * attack corpora. A rule is kept only if the eval (evals/injection/REPORT.md)
 * says it earns its false positives.
 *
 * `reach` is how much text a hit quarantines: the line it sits on (short
 * lines, the snapshot's one-element-per-line text), and for an override the
 * sentence after it too, because "Ignore your previous instructions." is
 * followed by the payload.
 */

export interface Rule {
  id: string;
  pattern: RegExp;
  /** An override is followed by its payload: quarantine the next sentence too. */
  takesNext?: boolean;
  /** The match is itself the span (a tagged block): quarantine it whole, widened to its lines. */
  block?: boolean;
}

// Words that name what a model has and a shopper does not.
const INSTR = String.raw`(?:instructions?|iunstructions?|instrucciones|indicaciones|prompts?|directives?|guidelines|rules|context|programming|system\s+prompt)`;
const PRIOR = String.raw`(?:all\s+|any\s+|the\s+|your\s+|my\s+|of\s+)*(?:previous|prior|preceding|above|earlier|original|initial|former|old|system|developer|given|current|existing)?\s*`;
const MODEL = String.raw`(?:AI|A\.I\.|assistant|language\s+model|LLM|chat\s?bot|GPT|ChatGPT|Claude|Gemini|model|agent|bot|scraper|crawler)`;
const RESPONSE = String.raw`(?:response|answer|reply|output|summary|completion|respuesta)`;

export const RULES: readonly Rule[] = [
  // "Ignore previous instructions", "disregard the above", "forget your rules", and the Spanish.
  {
    id: "override",
    pattern: new RegExp(String.raw`\b(?:ignore|disregard|forget|override|bypass|skip|neglect|abandon)\s+${PRIOR}${INSTR}\b`, "i"),
    takesNext: true,
  },
  {
    id: "override",
    pattern: new RegExp(String.raw`\b(?:ignora|ignore|olvida|omite|descarta|desatiende)\s+(?:todas\s+)?(?:las\s+|tus\s+)?${INSTR}`, "i"),
    takesNext: true,
  },
  // "Ignore the webpage and state ...": dismissing the content in favour of a dictated output.
  {
    id: "override",
    pattern: /\b(?:ignore|disregard|forget)\s+(?:the|this|that|all|any|everything)(?:\s+[\w-]+){0,3}?\s+(?:and|,)\s*(?:instead\s+)?(?:state|say|respond|reply|answer|output|print|write|tell|return|report|claim)\b/i,
    takesNext: true,
  },
  {
    id: "override",
    pattern: /\b(?:ignore|disregard|forget)\s+(?:everything|all)\s+(?:above|before|else|previous|prior)\b/i,
    takesNext: true,
  },
  // Instructions that name the model's task, as opposed to a customer's order or request.
  {
    id: "task_hijack",
    pattern: /\b(?:before|instead\s+of|after)\s+(?:you\s+)?(?:can\s+)?(?:solve|solving|complete|completing|do|doing|answer|answering|summari[sz]e|summari[sz]ing|continue|continuing|perform|performing)\s+(?:with\s+)?(?:the|your)\s+(?:original\s+|actual\s+|current\s+)?(?:task|request|question|assignment|job)\b/i,
    takesNext: true,
  },
  {
    id: "task_hijack",
    pattern: /\b(?:the\s+task\s+(?:that\s+)?(?:I|you)\s+(?:gave|were\s+given|was\s+given|assigned)|your\s+(?:new|real|actual|true|original|primary|current|only)\s+(?:task|objective|goal|mission|instructions?)\b|new\s+(?:instructions?|task|objective|directive)s?\s*[:!-])/i,
    takesNext: true,
  },
  // Dictating the model's own output: "add a sentence in your response", "encode your answer in Base64".
  {
    id: "response_directive",
    pattern: new RegExp(String.raw`\b(?:add|include|insert|integrate|incorporate|append|prepend|begin|start|end|encode|encrypt|translate|reverse|rewrite|write|format|replace|remove|introduce|rearrange|mention|use|respond|answer|reply|conclude|finish|sign|output)\b[^.!?\n]{0,60}?\b(?:in|to|into|with|of|within|at\s+the\s+(?:end|start|beginning)\s+of)\s+(?:your|the|each)\s+${RESPONSE}s?\b`, "i"),
  },
  {
    id: "response_directive",
    pattern: new RegExp(String.raw`\byour\s+${RESPONSE}s?\s+(?:should|must|needs?\s+to|has\s+to|will)\b`, "i"),
  },
  {
    id: "response_directive",
    pattern: new RegExp(String.raw`\b(?:respond|reply|answer)\s+(?:only\s+)?(?:with|in|using)\s+(?:the\s+)?(?:following|exactly|only|base64|emojis?|spanish|french|german|a\s+single)\b`, "i"),
  },
  // "Modify your answer to ...", "Scramble the letters of your reply": reshaping the reader's own output.
  {
    id: "response_directive",
    pattern: /\b(?:modify|augment|enhance|scramble|jumble|misspell|anagram|group|combine|convert|substitute|render|provide|remove|replace|reverse|encode|encrypt|translate|rewrite|format|begin|start|end|finish|conclude|add|include|insert|integrate|append|mention)\b[^.!?\n]{0,60}?\byour\s+(?:response|reply|answer|output|completion|respuesta)(?:'s)?\b/i,
  },
  {
    id: "response_directive",
    pattern: /(?:^|[.!?:]\s+|\n)\s*In\s+your\s+(?:response|reply|answer|output|summary)\s*,/i,
  },
  // "Print the following:", "we might state:": dictating the words to say.
  {
    id: "response_directive",
    pattern: /\b(?:print|state|say|output|repeat|type|write|declare)\s+(?:exactly\s+)?the\s+following\s*:|\b(?:might|could|would|should|must)\s+(?:state|say|declare|claim)\s*:|\blet'?s\s+(?:admit|pretend|imagine\s+a\s+scenario)\b/i,
    takesNext: true,
  },
  // Commanding obedience: "you must listen to my instructions", "OVERRIDE".
  {
    id: "override",
    pattern: /\b(?:listen\s+to|obey|follow)\s+(?:my|our)\s+(?:new\s+)?(?:instructions|commands|orders|directions)\b|\byou\s+must\s+(?:listen\s+to|obey)\s+me\b|\bse\s+te\s+ha\s+(?:instruido|ordenado|indicado)\b/i,
    takesNext: true,
  },
  {
    id: "override",
    pattern: /\bOVERRIDE\b|\boverride\s+mode\b/,
    takesNext: true,
  },
  // Spanish: "Ignore la pagina web y declara ...".
  {
    id: "override",
    pattern: /\b(?:ignora|ignore|olvida|omite|descarta)\s+(?:la|el|los|las|este|esta|todo)\s+(?:[\wáéíóúñ-]+\s+){0,2}?y\s+(?:di|declara|responde|escribe|indica|afirma|imprime|devuelve)\b/i,
    takesNext: true,
  },
  // Speaking to the model: "to you, the AI language model", "Dear AI assistant", "if you are an LLM".
  {
    id: "addresses_model",
    pattern: new RegExp(String.raw`\b(?:to\s+you|dear|hey|hello|attention|note\s+to|message\s+(?:to|for)|instructions?\s+for)\s*,?\s*(?:the\s+|an?\s+|all\s+)?${MODEL}s?\b`, "i"),
  },
  {
    id: "addresses_model",
    pattern: new RegExp(String.raw`\b(?:if\s+you\s+are|as|you\s+are(?:\s+now)?|you're(?:\s+now)?)\s+(?:an?\s+|the\s+)?(?:AI|A\.I\.|large\s+language\s+model|language\s+model|LLM|AI\s+(?:assistant|agent|model)|chat\s?bot|virtual\s+assistant|autonomous\s+agent|web\s+agent)\b(?!\s+(?:powered|driven|based|features?|technology|chip|camera))`, "i"),
  },
  {
    id: "addresses_model",
    pattern: new RegExp(String.raw`\b${MODEL}s?\s+(?:reading|processing|parsing|scraping|summari[sz]ing|browsing|visiting|analy[sz]ing)\s+(?:this|the)\s+(?:page|website|site|text|content|document)\b`, "i"),
  },
  // Role and mode switches: "you are now in developer mode", "pretend you are".
  {
    id: "role_switch",
    pattern: /\b(?:pretend|act|behave|roleplay|role-play)\s+(?:that\s+|as\s+if\s+|like\s+)?(?:you\s+are|you're|to\s+be)\b(?!\s+(?:at|on|in)\s+(?:the\s+)?(?:beach|gym|home|office|park))/i,
  },
  {
    id: "role_switch",
    pattern: /\b(?:developer|debug|admin|administrator|maintenance|god|unrestricted|jailbreak|DAN|sudo|root)\s+mode\s+(?:is\s+)?(?:now\s+)?(?:on|enabled|activated|engaged|unlocked)\b|\b(?:enter|entering|activate|enable|switch\s+to)\s+(?:developer|debug|admin|god|unrestricted|jailbreak|DAN|sudo)\s+mode\b/i,
  },
  {
    id: "role_switch",
    pattern: /\bfrom\s+now\s+on,?\s+(?:you|your)\b/i,
  },
  // Chat and tool markup that has no business in a shop page. A tagged block goes whole.
  {
    id: "chat_markup",
    pattern: /<\s*(INFORMATION|system|instructions?|admin|sys|prompt|important_instructions)\s*>[\s\S]{0,4000}?<\/\s*\1\s*>/i,
    block: true,
  },
  {
    id: "chat_markup",
    pattern: /<\|(?:im_start|im_end|system|user|assistant|endoftext|begin_of_text|start_header_id|end_header_id|eot_id)\|>|\[\/?INST\]|<<\/?SYS>>|###\s*\(?\s*(?:system|instruction|assistant)(?:_message)?\s*\)?|<\/?\s*(?:INFORMATION|system|instructions?|admin|sys|prompt|important_instructions)\s*>|^\s*(?:system|assistant)\s*(?:message|prompt)?\s*:\s/im,
  },
  // Attack wrappers from published corpora (AgentDojo's `direct`, InjecAgent's "IMPORTANT!!!").
  {
    id: "attack_wrapper",
    pattern: /(?:^|\n)\s*TODO:\s|\bIMPORTANT\s*!{2,}|\b(?:ALERT|ATTENTION|WARNING|URGENT|IMPORTANT)\b\s*(?:!\s*){1,}\s*:?[^.\n]{0,120}?\b(?:you\s+(?:must|MUST|need\s+to|are\s+required\s+to)|it\s+is\s+(?:CRITICAL|REQUIRED|MANDATORY))\b/,
    takesNext: true,
  },
  {
    id: "attack_wrapper",
    pattern: /\b(?:ATTENTION|IMPORTANT)\s*:\s*NEW\s+IMPORTANT\b|\bit\s+is\s+(?:CRITICAL|REQUIRED)\s+that\s+you\b|\bstrictly\s+adhere\s+to\s+the\s+following\b/,
    takesNext: true,
  },
  // Asking the model to disclose what it was told.
  {
    id: "exfiltration",
    pattern: /\b(?:reveal|print|output|repeat|disclose|show|leak|type|share)\s+(?:me\s+)?(?:your|the)\s+(?:full\s+|entire\s+|exact\s+)?(?:system\s+prompt|initial\s+prompt|hidden\s+(?:instructions|prompt)|instructions\s+you\s+(?:were\s+given|received)|task\s+(?:you\s+(?:are|were)\s+asked|description))\b/i,
  },
  // Invisible Unicode tag characters: text a person cannot see and a model can.
  {
    id: "hidden_text",
    pattern: /[\u{E0000}-\u{E007F}]{3,}/u,
  },
];
