#include <stdio.h>
#include "util.h"

static int counter = 0;

int main() {
    Point p = {1, 2};
    int sum = add(p.x, p.y);
    int prod = multiply(sum, 2);
    counter++;
    printf("%d %d\n", sum, prod);
    return 0;
}
