/* global hexo */
const logger = require('hexo-log')();

/**
 * Print welcome message
 */
logger.info(`=======================================
  ___    ___ ___  ________   ________      
 |\\  \\  /  /|\\  \\|\\   ___  \\|\\   ____\\     
 \\ \\  \\/  / | \\  \\ \\  \\\\ \\  \\ \\  \\___|_    
  \\ \\    / / \\ \\  \\ \\  \\\\ \\  \\ \\_____  \\   
   \\/  /  /   \\ \\  \\ \\  \\\\ \\  \\|____|\\  \\  
 __/  / /      \\ \\__\\ \\__\\\\ \\__\\____\\_\\  \\ 
|\\___/ /        \\|__|\\|__| \\|__|\\_________\\
\\|___|/                        \\|_________|
=============================================`);

/**
 * Check if all dependencies are installed
 */
require('../include/dependency')(hexo);

/**
 * Configuration file checking and migration
 */
require('../include/config')(hexo);

/**
 * Register Hexo extensions and remove Hexo filters that could cause OOM
 */
require('../include/register')(hexo);
