import htmlparser from 'htmlparser2';
import _ from 'lodash';

/*

# Idea
Provide a text box that the user can enter custom message routing rules.
Eg:
    * Copying all messages from a single user to another buffer
    * Moving notice messages from a services bot to your active channel or another buffer
    * Executing a custom IRC command when a specific message arrives
    * Forward all CTCPs to another IRC user
    * Copy all private messages to a single buffer window

# Example rule
to="$me" from="chanserv" contains="kiwi" put=#kiwi_mentions exec="/notice #kiwiirc somec :o"

# variables
$me - your current nick
$channel - your current channel
$network - the network name

# matching a message from a rule
to - if a message is targetted to this name (channel or nick), then match this rule
from - if a message is from this name (nick), then match this rule
isPm - if this pessage is a private message sent to us
contains - if a message contains this text, then match this rule
type - if the type of message is an action/notice/message, apply this rule
irc.command - if the irc command that created this message is this value, then match the rule
tags.contains - if the message tags contain this tag, then match the rule
tags.match - if a message tag matches this value, then match the rule

# if the rule has matched, then the following can be used:
put - put this message into this buffer. empty string for nowhere
copy - copy this message into this buffer
exec - execute this command as if it were typed in the control input
*/

export default class MessageRouter {
    constructor() {
        this.rules = [];
        this.parse = null;

        this.initParser();
    }

    // Creates the this.parse() function with a cached parser instance
    initParser() {
        let createParser = () => {
            let r = [];
            let parser = new htmlparser.Parser({
                onopentag: (name, attribs) => {
                    r.push(attribs);
                },
            });

            function maybeHtmlWrapLine(line) {
                return line.trim() ?
                    `<rule ${line}>` :
                    line;
            }

            return function parseRuleString(input) {
                r = [];
                let lines = input
                    .split('\n')
                    .map(line => maybeHtmlWrapLine(line))
                    .join('\n');

                parser.write(lines);
                parser.end();
                return r;
            };
        };

        this.parse = createParser();
    }

    // Clear all existing rules and add a parsed rules string
    resetRulesFromString(str) {
        let newRules = this.parse(str);
        if (newRules) {
            this.rules = newRules;
        } else {
            throw new Error('Error parsing rules');
        }
    }

    // Parse a rule string into a rule object and add it to our list of rules
    addRulesFromString(str) {
        let newRules = this.parse(str);
        if (newRules) {
            this.rules.concat(...newRules);
        } else {
            throw new Error('Error parsing rules');
        }
    }

    // Add a single rule to our list of rules
    addRule(rule = {}) {
        this.rules.push(rule);
    }

    // Get a list of target buffer names after applying all the rules to an IRC message
    bufferNamesFromMessage(ircMessage, ircClient, vars = {}) {
        let isPm = false;
        let targetBuffer = ircMessage.from_server ?
            '*' :
            ircMessage.target;

        // PMs should go to a buffer with the name of the other user
        if (!ircMessage.from_server && ircMessage.target === ircClient.user.nick) {
            targetBuffer = ircMessage.nick;
            isPm = true;
        }

        let rule = this.findMatchingRule(ircMessage, ircClient, isPm, vars);

        // No rule found, keep everything as default
        if (!rule) {
            return { buffers: [targetBuffer], execs: [] };
        }

        let buffers = [];
        let execs = [];

        // Put the message in some buffers
        if (rule.put) {
            buffers = rule.put.split(',');
        }

        // Copy the messages to some buffers
        if (rule.copy) {
            buffers = [targetBuffer, ...rule.copy.split(',')];
        }

        // Execute some IRC commands
        if (rule.exec) {
            execs.push(rule.exec);
        }

        return { buffers, execs };
    }

    // Find the first rule that matches an IRC message
    findMatchingRule(ircMessage, ircClient, isPm, vars = {}) {
        // Apply any vars to the input string
        let doVars = (input) => {
            let out = input;
            Object.keys(vars).forEach((varName) => {
                // TODO: Cache these regexs somewhere
                let regexp = new RegExp(_.escapeRegExp('$' + varName), 'g');
                out = out.replace(regexp, vars[varName]);
            });

            return out;
        };

        // Compare 2 strings helper
        let compare = (s1, s2) => {
            if (typeof s1 !== 'string' || typeof s2 !== 'string') {
                return false;
            }

            return s1.toLowerCase().trim() === s2.toLowerCase().trim();
        };

        let compareWithVars = (s1, s2) => {
            if (typeof s1 !== 'string') {
                return false;
            }

            return compare(doVars(s1), s2);
        };

        // If a string starts and ends with / then it's a regex string
        let isRegex = (input) => {
            if (!input || typeof input !== 'string') {
                return false;
            }

            return input[0] === '/' && input[input.length - 1] === '/';
        };

        // Normalise a string to lowercase
        let n = (input) => {
            if (typeof input !== 'string') {
                return '';
            }

            return input.toLowerCase().trim();
        };

        let rule = null;

        for (let i = 0; i < this.rules.length; i++) {
            rule = this.rules[i];

            if (rule.isPm === 'yes' && isPm) {
                break;
            }
            if (rule.isPm === 'no' && !isPm) {
                break;
            }
            if (compare(rule.type, ircMessage.type)) {
                break;
            }
            if (compareWithVars(rule.to, ircMessage.target)) {
                break;
            }
            if (compareWithVars(rule.from, ircMessage.nick)) {
                break;
            }

            // rule.contains could be a /regex/ or plain string
            if (isRegex(rule.contains)) {
                try {
                    let r = new RegExp(rule.contains, 'gi');
                    if (r.test(ircMessage.message || '')) {
                        break;
                    }
                } catch (err) {
                    // TODO: Log this regex parse fail somewhere
                }
            } else if (rule.contains && n(ircMessage.message).indexOf(n(rule.contains)) > -1) {
                break;
            }

            // Does the message contain a specific tag
            let t = doVars(rule['tags.contains']);
            if (t && typeof ircMessage.tags[t] !== 'undefined') {
                break;
            }

            // Does the message contain a tag and does it match a specific value
            if (compareWithVars(rule['tags.match'], ircMessage.tags[rule['tags.match']])) {
                break;
            }

            if (compare(rule['irc.command'], ircMessage.command)) {
                break;
            }

            rule = null;
        }

        return rule;
    }
}
