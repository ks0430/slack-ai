module.exports = {
    'env': {
        'node': true,
        'es2021': true,
        'jest': true
    },
    'extends': 'eslint:recommended',
    'parserOptions': {
        'ecmaVersion': 'latest',
        'sourceType': 'module'
    },
    'rules': {
        'indent': ['error', 4],
        'semi': ['error', 'always']
    }
}; 